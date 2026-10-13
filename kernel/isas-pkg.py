#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""isas-pkg: the plugin resolver for .isas notebooks (ISAS-SAS-PLUGIN-DESIGN.md section 2b, row PR).

The only code that touches the network; the notebook page never fetches.  Stdlib only, native only.

Usage: isas-pkg.py [-d DIR] [--proxy LIST] CMD [ARG]
  DIR   the notebook side folder <name>.isas.d (default ./notebook.isas.d)
  CMD   add <path>[@vX.Y.Z] | update [<path>] | vendor | verify | tidy | mirror <dir>
Files in DIR: plugins.req (notebook requirements, `require <path> <vX.Y.Z>` lines), plugins.lock,
              plugins/<escaped-path>@<ver>/ (vendored trees).
Env:  ISAS_PKG_PROXY   ordered list (GOPROXY style): direct | off | file:///dir | https://host ; default `direct`
      ISAS_PKG_GITBASE test hook: `direct` clones <GITBASE>/<repo-root>.git instead of https://<repo-root>.git
Exit: 0 ok; 2 refusal (stderr `PkgName: detail`, nothing vendored); 64 usage.
"""
import hashlib, io, json, os, re, shutil, subprocess, sys, tarfile, tempfile, urllib.request

ALLOW = {"AGPL-3.0-only", "MIT", "BSD-3-Clause", "Apache-2.0", "CC0-1.0"}
SEMVER = re.compile(r"^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
MAJSUF = re.compile(r"^(.*)/v([2-9]|[1-9][0-9]+)$")


class Pkg(Exception):
    def __init__(self, name, detail=""):
        super().__init__("%s: %s" % (name, detail))
        self.name, self.detail = name, detail


class Unavail(Exception):
    """a source does not have it (not a refusal by itself)"""
    def __init__(self, why, missing=False):
        super().__init__(why)
        self.why, self.missing = why, missing


# ---- paths, versions ---------------------------------------------------------------------------------------------
def esc(path):
    return "".join("!" + c.lower() if c.isupper() else c for c in path)


def vkey(v):
    return tuple(int(x) for x in SEMVER.match(v).groups())


def split_path(path):
    """module path -> (repo root, subdir, major).  repo root = first 3 components (host/owner/repo)."""
    base, major = path, 1
    m = MAJSUF.match(path)
    if m:
        base, major = m.group(1), int(m.group(2))
    parts = base.split("/")
    if len(parts) < 3 or not all(re.match(r"^[A-Za-z0-9._~-]+$", p) for p in parts):
        raise Pkg("PkgPathMismatch", "bad module path %r" % path)
    return "/".join(parts[:3]), "/".join(parts[3:]), major


def check_ver(path, ver):
    if not SEMVER.match(ver or ""):
        raise Pkg("PkgTagMissing", "%s: %r is not a strict semver tag vMAJOR.MINOR.PATCH" % (path, ver))
    major = vkey(ver)[0]
    want = split_path(path)[2]
    if (want == 1 and major > 1) or (want > 1 and major != want):
        raise Pkg("PkgTagMissing", "%s@%s: major version does not fit the path" % (path, ver))


# ---- tree hash and tar -------------------------------------------------------------------------------------------
def tree_files(root):
    out = []
    for dp, dn, fn in os.walk(root):
        dn[:] = sorted(d for d in dn if d != ".git")
        for f in fn:
            p = os.path.join(dp, f)
            if os.path.islink(p) or not os.path.isfile(p):
                raise Pkg("PkgBadTree", "not a regular file: " + os.path.relpath(p, root))
            out.append(os.path.relpath(p, root).replace(os.sep, "/"))
    return sorted(out, key=lambda s: s.encode())


def tree_hash(root):
    """go.sum h1: sha256 over sorted lines `sha256(file)  relpath\\n`, .git excluded"""
    lines = "".join("%s  %s\n" % (hashlib.sha256(open(os.path.join(root, r), "rb").read()).hexdigest(), r)
                    for r in tree_files(root))
    return "h1:" + hashlib.sha256(lines.encode()).hexdigest()


def make_tar(root):
    b = io.BytesIO()
    with tarfile.open(fileobj=b, mode="w") as t:
        for r in tree_files(root):
            ti = tarfile.TarInfo(r)
            data = open(os.path.join(root, r), "rb").read()
            ti.size, ti.mode, ti.mtime = len(data), 0o644, 0
            t.addfile(ti, io.BytesIO(data))
    return b.getvalue()


def extract_tar(data, dest):
    os.makedirs(dest)
    with tarfile.open(fileobj=io.BytesIO(data)) as t:
        for m in t.getmembers():
            n = m.name
            if not m.isreg() or n.startswith("/") or ".." in n.split("/") or "\\" in n:
                raise Pkg("PkgBadTree", "unsafe tar member %r" % n)
            p = os.path.join(dest, n)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, "wb").write(t.extractfile(m).read())


# ---- plugin.mod ---------------------------------------------------------------------------------------------------
def parse_mod(root, path):
    p = os.path.join(root, "plugin.mod")
    if not os.path.isfile(p):
        raise Pkg("PkgNoModFile", "%s: no plugin.mod" % path)
    raw = open(p, "rb").read()
    try:
        txt = raw.decode("ascii")
    except UnicodeDecodeError:
        raise Pkg("PkgNoModFile", "%s: plugin.mod is not ASCII" % path)
    mod = {"path": None, "licence": None, "require": []}
    for ln in txt.splitlines():
        w = ln.split()
        if not w:
            continue
        if w[0] in ("path", "licence") and len(w) == 2:
            mod[w[0]] = w[1]
        elif w[0] == "require" and len(w) == 3 and SEMVER.match(w[2]):
            mod["require"].append((w[1], w[2]))
        else:
            raise Pkg("PkgNoModFile", "%s: bad plugin.mod line %r" % (path, ln))
    if not mod["path"] or not mod["licence"]:
        raise Pkg("PkgNoModFile", "%s: plugin.mod lacks path or licence" % path)
    return mod


def check_tree(path, tree):
    mod = parse_mod(tree, path)
    if mod["path"] != path:
        raise Pkg("PkgPathMismatch", "plugin.mod path %s != %s" % (mod["path"], path))
    lic = mod["licence"]
    if lic not in ALLOW:
        raise Pkg("PkgLicenceRefused", "%s: licence %s is not on the allowlist (NC and unknown are refused)" % (path, lic))
    if not os.path.isfile(os.path.join(tree, "LICENSE")):
        raise Pkg("PkgLicenceRefused", "%s: no LICENSE file" % path)
    return mod


# ---- sources ------------------------------------------------------------------------------------------------------
def git(*a, cwd=None):
    r = subprocess.run(["git", *a], cwd=cwd, capture_output=True, text=True,
                       env=dict(os.environ, GIT_TERMINAL_PROMPT="0"))
    if r.returncode:
        raise Unavail("git %s: %s" % (a[0], r.stderr.strip().splitlines()[-1] if r.stderr.strip() else r.returncode))
    return r.stdout


class Direct:
    name = "direct"

    def url(self, path):
        root = split_path(path)[0]
        base = os.environ.get("ISAS_PKG_GITBASE")
        return "%s/%s.git" % (base, root) if base else "https://%s.git" % root

    def tagname(self, path, ver):
        sub = split_path(path)[1]
        return (sub + "/" if sub else "") + ver

    def versions(self, path):
        sub = split_path(path)[1]
        pre = "refs/tags/" + (sub + "/" if sub else "")
        out = set()
        for ln in git("ls-remote", "--tags", self.url(path)).splitlines():
            ref = ln.split("\t")[1].replace("^{}", "")
            if ref.startswith(pre) and SEMVER.match(ref[len(pre):]):
                out.add(ref[len(pre):])
        return out

    def fetch(self, path, ver, dest):
        if ver not in self.versions(path):
            raise Unavail("tag %s absent" % self.tagname(path, ver), missing=True)
        tmp = tempfile.mkdtemp(prefix="clone")
        try:
            git("clone", "--quiet", "--depth", "1", "--branch", self.tagname(path, ver), self.url(path), tmp + "/c")
            commit = git("rev-parse", "HEAD", cwd=tmp + "/c").strip()
            shutil.rmtree(tmp + "/c/.git")
            sub = split_path(path)[1]
            src = os.path.join(tmp, "c", sub)
            if not os.path.isdir(src):
                raise Unavail("subdir %s absent in %s" % (sub, ver), missing=True)
            shutil.copytree(src, dest, symlinks=True)
            return commit
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class Mirror:
    """static layout: <esc path>/@v/list, <ver>.info, <ver>.tar ; file:///dir or http(s)://"""
    def __init__(self, base):
        self.base, self.name = base.rstrip("/"), base

    def get(self, rel):
        u = "%s/%s" % (self.base, rel)
        try:
            if u.startswith("file://"):
                return open(u[7:], "rb").read()
            return urllib.request.urlopen(u, timeout=30).read()
        except FileNotFoundError:
            raise Unavail("%s: not found" % u, missing=True)
        except Exception as e:
            raise Unavail("%s: %s" % (u, e))

    def versions(self, path):
        return {v for v in self.get(esc(path) + "/@v/list").decode().split() if SEMVER.match(v)}

    def fetch(self, path, ver, dest):
        if ver not in self.versions(path):
            raise Unavail("%s absent in %s" % (ver, self.base), missing=True)
        info = json.loads(self.get("%s/@v/%s.info" % (esc(path), ver)))
        extract_tar(self.get("%s/@v/%s.tar" % (esc(path), ver)), dest)
        return info.get("Commit", "")


def proxies():
    spec = os.environ.get("ISAS_PKG_PROXY", "direct")
    return [s for s in spec.split(",") if s.strip()] or ["direct"]


class Resolver:
    """fetch with the ordered proxy list; caches (path, ver) -> (tree dir, commit) for one run"""
    def __init__(self, spec, work):
        self.spec, self.work, self.cache, self.n = spec, work, {}, 0

    def srcs(self):
        for s in self.spec:
            s = s.strip()
            yield s, (None if s == "off" else Direct() if s == "direct" else Mirror(s))

    def _walk(self, what, fn):
        tried = []
        for s, src in self.srcs():
            if src is None:
                if tried:
                    raise Pkg("PkgUnreachable", "%s; then `off`: %s" % (what, "; ".join(tried)))
                raise Pkg("PkgOffline", "%s: proxy is off and the tree is not vendored" % what)
            try:
                return fn(src)
            except Unavail as u:
                tried.append("%s: %s" % (s, u.why))
                if not u.missing:
                    tried[-1] += " (unreachable)"
        if all("(unreachable)" not in t for t in tried):
            raise Pkg("PkgTagMissing", "%s: %s" % (what, "; ".join(tried)))
        raise Pkg("PkgUnreachable", "%s: %s" % (what, "; ".join(tried)))

    def tree(self, path, ver):
        check_ver(path, ver)
        k = (path, ver)
        if k not in self.cache:
            self.n += 1
            dest = os.path.join(self.work, "t%d" % self.n)

            def one(s):
                shutil.rmtree(dest, ignore_errors=True)
                return s.fetch(path, ver, dest) or ""
            commit = self._walk("%s@%s" % (path, ver), one)
            self.cache[k] = (dest, commit)
        return self.cache[k]

    def latest(self, path, major_of=None):
        def f(s):
            vs = [v for v in s.versions(path) if (split_path(path)[2] == 1 and vkey(v)[0] <= 1)
                  or vkey(v)[0] == split_path(path)[2]]
            if not vs:
                raise Unavail("no semver tags", missing=True)
            return max(vs, key=vkey)
        return self._walk(path, f)


# ---- state files --------------------------------------------------------------------------------------------------
def read_req(d):
    p = os.path.join(d, "plugins.req")
    out = {}
    if os.path.isfile(p):
        for ln in open(p).read().splitlines():
            w = ln.split()
            if w:
                if len(w) != 3 or w[0] != "require" or not SEMVER.match(w[2]):
                    raise Pkg("IsasPluginBadManifest", "plugins.req line %r" % ln)
                out[w[1]] = w[2]
    return out


def write_req(d, req):
    open(os.path.join(d, "plugins.req"), "w").write("".join("require %s %s\n" % (p, req[p]) for p in sorted(req)))


def read_lock(d):
    p = os.path.join(d, "plugins.lock")
    out = {}
    if os.path.isfile(p):
        for ln in open(p).read().splitlines():
            w = ln.split()
            if not w:
                continue
            if len(w) != 5 or not w[2].startswith("h1:"):
                raise Pkg("IsasPluginBadManifest", "plugins.lock line %r" % ln)
            out[(w[0], w[1])] = {"h1": w[2], "licence": w[3], "commit": w[4]}
    return out


def lock_text(lock):
    return "".join("%s %s %s %s %s\n" % (p, v, e["h1"], e["licence"], e["commit"])
                   for (p, v), e in sorted(lock.items(), key=lambda kv: (kv[0][0], vkey(kv[0][1]))))


def vdir(d, path, ver):
    return os.path.join(d, "plugins", "%s@%s" % (esc(path), ver))


# ---- MVS ----------------------------------------------------------------------------------------------------------
def mvs(req, res, lock):
    """build list {path: ver}: max of the minimum versions required by the notebook and every plugin.mod"""
    best, seen, info = dict(req), set(), {}
    while True:
        todo = [(p, v) for p, v in best.items() if (p, v) not in seen]
        if not todo:
            return best, info
        for p, v in todo:
            seen.add((p, v))
            tree, commit = res.tree(p, v)
            h1 = tree_hash(tree)
            if (p, v) in lock and lock[(p, v)]["h1"] != h1:
                raise Pkg("PkgHashMismatch", "%s@%s: fetched %s, lock has %s" % (p, v, h1, lock[(p, v)]["h1"]))
            mod = check_tree(p, tree)
            info[(p, v)] = {"h1": h1, "licence": mod["licence"], "commit": commit or "-", "tree": tree}
            for rp, rv in mod["require"]:
                check_ver(rp, rv)
                if rp not in best or vkey(rv) > vkey(best[rp]):
                    best[rp] = rv


def commit_state(d, req, best, info, lock_old):
    """write vendor trees + lock + req atomically enough: stage first, then move"""
    os.makedirs(d, exist_ok=True)
    lock = {}
    for p, v in best.items():
        i = info[(p, v)]
        lock[(p, v)] = {k: i[k] for k in ("h1", "licence", "commit")}
        dest = vdir(d, p, v)
        if os.path.isdir(dest):
            if tree_hash(dest) == i["h1"]:
                continue
            shutil.rmtree(dest)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copytree(i["tree"], dest)
    # prune superseded versions of the same paths
    for (p, v) in lock_old:
        if (p, v) not in lock and os.path.isdir(vdir(d, p, v)):
            shutil.rmtree(vdir(d, p, v))
    write_req(d, req)
    open(os.path.join(d, "plugins.lock"), "w").write(lock_text(lock))


# ---- commands -----------------------------------------------------------------------------------------------------
def cmd_add(d, res, arg):
    path, _, ver = arg.partition("@")
    split_path(path)
    if not ver:
        ver = res.latest(path)
    check_ver(path, ver)
    req = read_req(d)
    if path in req and vkey(req[path]) > vkey(ver):
        ver = req[path]
    req[path] = ver
    run_resolve(d, res, req)


def cmd_update(d, res, arg):
    req = read_req(d)
    for p in ([arg] if arg else sorted(req)):
        if p not in req:
            raise Pkg("PkgTagMissing", "%s is not required by this notebook" % p)
        v = res.latest(p)
        if vkey(v) > vkey(req[p]):
            req[p] = v
    run_resolve(d, res, req)


def run_resolve(d, res, req):
    lock = read_lock(d)
    best, info = mvs(req, res, lock)
    commit_state(d, req, best, info, lock)


def cmd_vendor(d, res, _):
    """materialise every lock entry; already-vendored trees that hash right need no fetch (works with proxy off)"""
    lock = read_lock(d)
    todo = []
    for (p, v), e in lock.items():
        dest = vdir(d, p, v)
        if os.path.isdir(dest) and tree_hash(dest) == e["h1"]:
            continue
        todo.append((p, v, e))
    staged = []
    for p, v, e in todo:
        tree, commit = res.tree(p, v)
        h1 = tree_hash(tree)
        if h1 != e["h1"]:
            raise Pkg("PkgHashMismatch", "%s@%s: fetched %s, lock has %s" % (p, v, h1, e["h1"]))
        check_tree(p, tree)
        staged.append((p, v, tree))
    for p, v, tree in staged:
        dest = vdir(d, p, v)
        if os.path.isdir(dest):
            shutil.rmtree(dest)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copytree(tree, dest)


def cmd_verify(d, res, _):
    lock = read_lock(d)
    for (p, v), e in sorted(lock.items()):
        dest = vdir(d, p, v)
        if not os.path.isdir(dest):
            raise Pkg("PkgOffline", "%s@%s: not vendored (run `vendor`)" % (p, v))
        got = tree_hash(dest)
        if got != e["h1"]:
            raise Pkg("PkgHashMismatch", "%s@%s: vendored tree is %s, lock has %s" % (p, v, got, e["h1"]))
        if e["licence"] not in ALLOW:
            raise Pkg("PkgLicenceRefused", "%s@%s: lock licence %s" % (p, v, e["licence"]))
        check_tree(p, dest)


def cmd_tidy(d, res, _):
    """drop lock entries and vendored trees that no requirement reaches (offline: reads vendored plugin.mod)"""
    req, lock = read_req(d), read_lock(d)
    best = dict(req)
    changed = True
    while changed:
        changed = False
        for p, v in list(best.items()):
            dest = vdir(d, p, v)
            if not os.path.isdir(dest):
                raise Pkg("PkgOffline", "%s@%s: not vendored (run `vendor`)" % (p, v))
            for rp, rv in parse_mod(dest, p)["require"]:
                if rp not in best or vkey(rv) > vkey(best[rp]):
                    best[rp] = rv
                    changed = True
    keep = {k: e for k, e in lock.items() if best.get(k[0]) == k[1]}
    for k in lock:
        if k not in keep and os.path.isdir(vdir(d, *k)):
            shutil.rmtree(vdir(d, *k))
    open(os.path.join(d, "plugins.lock"), "w").write(lock_text(keep))


def cmd_mirror(d, res, out):
    if not out:
        raise SystemExit(64)
    lock = read_lock(d)
    for (p, v), e in sorted(lock.items()):
        src = vdir(d, p, v)
        if not os.path.isdir(src) or tree_hash(src) != e["h1"]:
            raise Pkg("PkgHashMismatch" if os.path.isdir(src) else "PkgOffline", "%s@%s: vendored tree missing or wrong" % (p, v))
        base = os.path.join(out, esc(p), "@v")
        os.makedirs(base, exist_ok=True)
        lst = os.path.join(base, "list")
        have = set(open(lst).read().split()) if os.path.isfile(lst) else set()
        have.add(v)
        open(lst, "w").write("".join(x + "\n" for x in sorted(have, key=vkey)))
        open(os.path.join(base, v + ".info"), "w").write(json.dumps({"Version": v, "Commit": e["commit"]}))
        open(os.path.join(base, v + ".tar"), "wb").write(make_tar(src))


CMDS = {"add": cmd_add, "update": cmd_update, "vendor": cmd_vendor, "verify": cmd_verify,
        "tidy": cmd_tidy, "mirror": cmd_mirror}


def main(argv):
    d, spec, a = "notebook.isas.d", None, list(argv)
    while a and a[0] in ("-d", "--proxy"):
        if len(a) < 2:
            return 64
        if a[0] == "-d":
            d = a[1]
        else:
            spec = a[1]
        a = a[2:]
    if not a or a[0] not in CMDS or len(a) > 2 or (a[0] == "add" and len(a) != 2):
        sys.stderr.write(__doc__)
        return 64
    spec = (spec if spec is not None else os.environ.get("ISAS_PKG_PROXY", "direct")).split(",")
    work = tempfile.mkdtemp(prefix="isas-pkg")
    try:
        CMDS[a[0]](d, Resolver([s for s in spec if s.strip()] or ["direct"], work), a[1] if len(a) > 1 else None)
        return 0
    except Pkg as e:
        sys.stderr.write("%s: %s\n" % (e.name, e.detail))
        return 2
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
