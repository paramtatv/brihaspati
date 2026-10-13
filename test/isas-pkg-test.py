#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""kernel/isas-pkg.py against local bare-repo fixtures in a temp dir.  No network.  Each refusal has a negative control
(the same step without the fault succeeds).  Run: python3 test/isas-pkg-test.py"""
import hashlib, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, "..", "kernel", "isas-pkg.py")
T = tempfile.mkdtemp(prefix="isas-pkg-test")
BASE = os.path.join(T, "git")
GENV = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t",
            GIT_AUTHOR_DATE="2026-01-01T00:00:00Z", GIT_COMMITTER_DATE="2026-01-01T00:00:00Z", GIT_CONFIG_GLOBAL="/dev/null")
bad = n = 0


def check(ok, what):
    global bad, n
    n += 1
    print("ok  " if ok else "FAIL", what)
    if not ok:
        bad += 1


def git(*a, cwd=None):
    subprocess.run(["git", *a], cwd=cwd, env=GENV, check=True, capture_output=True)


def mod(path, lic="MIT", req=()):
    return "path %s\nlicence %s\n" % (path, lic) + "".join("require %s %s\n" % r for r in req)


def mkrepo(root, tags, sub=""):
    """root = host/owner/repo ; tags = [(tag, {relpath: text})] ; sub = subdir that holds the package (tag prefixed sub/)"""
    w = os.path.join(T, "w-" + root.replace("/", "_"))
    shutil.rmtree(w, ignore_errors=True)
    os.makedirs(w)
    git("init", "-q", cwd=w)
    for tag, files in tags:
        for f in os.listdir(w):
            if f != ".git":
                shutil.rmtree(os.path.join(w, f)) if os.path.isdir(os.path.join(w, f)) else os.remove(os.path.join(w, f))
        for rel, txt in files.items():
            p = os.path.join(w, sub, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, "w").write(txt)
        git("add", "-A", cwd=w)
        git("commit", "-q", "--allow-empty", "-m", tag, cwd=w)
        git("tag", (sub + "/" if sub else "") + tag, cwd=w)
    bare = os.path.join(BASE, root + ".git")
    shutil.rmtree(bare, ignore_errors=True)
    os.makedirs(os.path.dirname(bare), exist_ok=True)
    git("clone", "-q", "--bare", w, bare)
    return w, bare


def pkg(path, ver, lic="MIT", req=(), extra=None, lic_file=True, modfile=True, modpath=None):
    f = {"main.t1": "मण्डलम् %s ॥\n" % path.split("/")[-1] + ver + "\n"}
    if modfile:
        f["plugin.mod"] = mod(modpath or path, lic, req)
    if lic_file:
        f["LICENSE"] = "licence text\n"
    f.update(extra or {})
    return f


def run(d, *args, proxy="direct", base=BASE):
    env = dict(os.environ, ISAS_PKG_GITBASE=base, ISAS_PKG_PROXY=proxy)
    r = subprocess.run([sys.executable, CLI, "-d", d, *args], env=env, capture_output=True, text=True)
    return r.returncode, r.stderr.strip()


def refused(d, name, what, *args, **kw):
    rc, err = run(d, *args, **kw)
    check(rc == 2 and err.startswith(name + ":"), "%s: refused as %s (rc=%d %s)" % (what, name, rc, err[:70] if not err.startswith(name) else ""))


def ok(d, what, *args, **kw):
    rc, err = run(d, *args, **kw)
    check(rc == 0, "%s: succeeds%s" % (what, "" if rc == 0 else " (" + err[:90] + ")"))


def nb(name):
    d = os.path.join(T, "nb-" + name + ".isas.d")
    shutil.rmtree(d, ignore_errors=True)
    return d


def tree_h1(root):  # independent re-implementation of the h1 rule
    ls = []
    for dp, dn, fn in os.walk(root):
        for f in fn:
            p = os.path.join(dp, f)
            ls.append((os.path.relpath(p, root), hashlib.sha256(open(p, "rb").read()).hexdigest()))
    ls.sort(key=lambda x: x[0].encode())
    return "h1:" + hashlib.sha256("".join("%s  %s\n" % (h, r) for r, h in ls).encode()).hexdigest()


def lockof(d):
    return open(os.path.join(d, "plugins.lock")).read() if os.path.exists(os.path.join(d, "plugins.lock")) else None


def vendored(d):
    out = []
    for dp, dn, fn in os.walk(os.path.join(d, "plugins")):
        if "plugin.mod" in fn:
            out.append(os.path.relpath(dp, os.path.join(d, "plugins")))
    return sorted(out)


# ---- 1 add, lock format, tree hash, strict semver, latest -------------------------------------------------------------
P = "example.test/acme/geom"
mkrepo("example.test/acme/geom", [("v1.0.0", pkg(P, "1.0.0")), ("v1.1.0", pkg(P, "1.1.0")), ("v0.9.0-rc1", pkg(P, "rc"))])
d = nb("add")
ok(d, "add without version", "add", P)
lk = lockof(d).split()
check(len(lk) == 5 and lk[0] == P and lk[1] == "v1.1.0" and lk[3] == "MIT" and len(lk[4]) == 40, "lock line is `<path> <ver> h1:.. <licence> <commit>`; latest strict-semver tag chosen (pre-release ignored)")
check(lk[2] == tree_h1(os.path.join(d, "plugins", P + "@v1.1.0")), "lock h1 equals an independent tree hash of the vendored tree")
check(open(os.path.join(d, "plugins.req")).read() == "require %s v1.1.0\n" % P, "plugins.req records the requirement")
check(not os.path.exists(os.path.join(d, "plugins", P + "@v1.1.0", ".git")), "vendored tree has no .git")
ok(d, "verify", "verify")
d2 = nb("add2")
ok(d2, "add @v1.0.0 (control for missing tag)", "add", P + "@v1.0.0")
check(lockof(d2).split()[1] == "v1.0.0", "explicit version honoured")

# ---- 2 missing tag / non-semver --------------------------------------------------------------------------------------
d = nb("missing")
refused(d, "PkgTagMissing", "absent tag v9.9.9", "add", P + "@v9.9.9")
check(lockof(d) is None and vendored(d) == [], "nothing vendored after PkgTagMissing")
refused(d, "PkgTagMissing", "branch name is not a version", "add", P + "@main")
refused(d, "PkgTagMissing", "pseudo/pre-release version refused", "add", P + "@v0.9.0-rc1")
refused(d, "PkgTagMissing", "major 2 without /v2 path", "add", P + "@v2.0.0")

# ---- 3 moved tag -> PkgHashMismatch ----------------------------------------------------------------------------------
d = nb("moved")
ok(d, "add before the tag moves", "add", P + "@v1.0.0")
shutil.rmtree(os.path.join(d, "plugins"))
ok(d, "re-vendor from unmoved tag (control)", "vendor")
shutil.rmtree(os.path.join(d, "plugins"))
w, bare = os.path.join(T, "w-example.test_acme_geom"), os.path.join(BASE, "example.test/acme/geom.git")
open(os.path.join(w, "main.t1"), "w").write("EVIL\n")
git("add", "-A", cwd=w); git("commit", "-q", "-m", "evil", cwd=w); git("tag", "-f", "v1.0.0", cwd=w)
git("push", "-q", "-f", bare, "refs/tags/v1.0.0", cwd=w)
before = lockof(d)
refused(d, "PkgHashMismatch", "moved tag v1.0.0", "vendor")
check(vendored(d) == [] and lockof(d) == before, "moved tag: nothing vendored, lock unchanged")
refused(d, "PkgHashMismatch", "moved tag via add (lock has the old hash)", "add", P + "@v1.0.0")

# ---- 4 licences ------------------------------------------------------------------------------------------------------
for lic, tag in (("CC-BY-NC-4.0", "nc"), ("LicenseRef-Mystery", "unk")):
    q = "example.test/acme/" + tag
    mkrepo(q, [("v1.0.0", pkg(q, "x", lic=lic))])
    d = nb(tag)
    refused(d, "PkgLicenceRefused", "%s licence" % lic, "add", q)
    check(vendored(d) == [] and lockof(d) is None, "%s: nothing vendored, no lock" % lic)
q = "example.test/acme/nolic"
mkrepo(q, [("v1.0.0", pkg(q, "x", lic_file=False))])
refused(nb("nolic"), "PkgLicenceRefused", "no LICENSE file", "add", q)
q = "example.test/acme/okmit"
mkrepo(q, [("v1.0.0", pkg(q, "x", lic="MIT"))])
ok(nb("okmit"), "MIT with LICENSE (control)", "add", q)
q = "example.test/acme/aapl"
mkrepo(q, [("v1.0.0", pkg(q, "x", lic="AGPL-3.0-only"))])
ok(nb("agpl"), "AGPL-3.0-only (control)", "add", q)
# a licence refused deep in the build list refuses the whole add
q1, q2 = "example.test/acme/top", "example.test/acme/deepnc"
mkrepo(q2, [("v1.0.0", pkg(q2, "x", lic="CC-BY-NC-4.0"))])
mkrepo(q1, [("v1.0.0", pkg(q1, "x", req=[(q2, "v1.0.0")]))])
d = nb("deepnc")
refused(d, "PkgLicenceRefused", "NC dependency refuses the whole add", "add", q1)
check(vendored(d) == [], "NC dependency: nothing vendored, not even the top package")
# lock licence column re-checked by verify
d = nb("lockedit")
ok(d, "add for lock edit", "add", "example.test/acme/okmit")
t = lockof(d).replace(" MIT ", " CC-BY-NC-4.0 ")
open(os.path.join(d, "plugins.lock"), "w").write(t)
refused(d, "PkgLicenceRefused", "lock licence column NC", "verify")

# ---- 5 mod file, path mismatch ---------------------------------------------------------------------------------------
q = "example.test/acme/nomod"
mkrepo(q, [("v1.0.0", pkg(q, "x", modfile=False))])
refused(nb("nomod"), "PkgNoModFile", "no plugin.mod", "add", q)
q = "example.test/acme/badmod"
mkrepo(q, [("v1.0.0", pkg(q, "x", extra={"plugin.mod": "path %s\nbogus line\n" % q}))])
refused(nb("badmod"), "PkgNoModFile", "malformed plugin.mod", "add", q)
q = "example.test/acme/wrongpath"
mkrepo(q, [("v1.0.0", pkg(q, "x", modpath="example.test/other/thing"))])
refused(nb("wrongpath"), "PkgPathMismatch", "plugin.mod path differs from the URL", "add", q)

# ---- 6 /v2 major path, two majors coexist ----------------------------------------------------------------------------
q = "example.test/acme/shape"
mkrepo(q, [("v1.2.0", pkg(q, "one")), ("v2.0.0", pkg(q + "/v2", "two"))])
d = nb("v2")
ok(d, "add /v2 path", "add", q + "/v2")
check(lockof(d).split()[:2] == [q + "/v2", "v2.0.0"], "/v2 resolves to the v2 tag")
refused(d, "PkgTagMissing", "/v2 path with a v1 tag", "add", q + "/v2@v1.2.0")
ok(d, "add v1 beside v2 (coexist)", "add", q)
check(sorted(x.split()[0] + " " + x.split()[1] for x in lockof(d).splitlines()) == sorted([q + " v1.2.0", q + "/v2 v2.0.0"]), "two majors coexist in one lock")
check(len(vendored(d)) == 2, "two vendored trees")
q = "example.test/acme/shape2"
mkrepo(q, [("v2.0.0", pkg(q, "wrong"))])
refused(nb("v2bad"), "PkgTagMissing", "v2 tag without /v2 in the path", "add", q)

# ---- 7 MVS -----------------------------------------------------------------------------------------------------------
B, A = "example.test/acme/libb", "example.test/acme/liba"
mkrepo(B, [("v1.1.0", pkg(B, "1")), ("v1.2.0", pkg(B, "2")), ("v1.3.0", pkg(B, "3"))])
mkrepo(A, [("v1.0.0", pkg(A, "a", req=[(B, "v1.2.0")]))])
d = nb("mvs")
os.makedirs(d)
open(os.path.join(d, "plugins.req"), "w").write("require %s v1.1.0\n" % B)
ok(d, "add A (needs B v1.2.0; notebook has B v1.1.0)", "add", A)
ents = {x.split()[0]: x.split()[1] for x in lockof(d).splitlines()}
check(ents == {A: "v1.0.0", B: "v1.2.0"}, "MVS picks max of the minimums (B v1.2.0), not latest v1.3.0: %s" % ents)
first = lockof(d)
shutil.rmtree(os.path.join(d, "plugins"))
os.remove(os.path.join(d, "plugins.lock"))
ok(d, "re-resolve from the same requirements", "add", A)
check(lockof(d) == first, "same inputs give a byte-identical lock")
check(open(os.path.join(d, "plugins.req")).read().count("require") == 2, "plugins.req lists the direct requirements only")
ok(d, "update B raises only on request", "update", B)
check({x.split()[0]: x.split()[1] for x in lockof(d).splitlines()}[B] == "v1.3.0", "update B -> v1.3.0")
check(len(vendored(d)) == 2, "update prunes the superseded B tree")
# notebook pin above what a dependency asks wins
d = nb("mvs2")
os.makedirs(d)
open(os.path.join(d, "plugins.req"), "w").write("require %s v1.3.0\n" % B)
ok(d, "add A with B pinned at v1.3.0", "add", A)
check({x.split()[0]: x.split()[1] for x in lockof(d).splitlines()}[B] == "v1.3.0", "notebook minimum above the dependency's wins")

# ---- 8 offline vendor, verify, tidy -----------------------------------------------------------------------------------
d = nb("off")
ok(d, "add geom v1.1.0", "add", P + "@v1.1.0")
ok(d, "verify offline", "verify", proxy="off", base="/nonexistent")
ok(d, "vendor offline when already vendored", "vendor", proxy="off", base="/nonexistent")
shutil.rmtree(os.path.join(d, "plugins"))
refused(d, "PkgOffline", "vendor offline, tree absent", "vendor", proxy="off", base="/nonexistent")
refused(d, "PkgOffline", "verify, tree absent", "verify", proxy="off")
ok(d, "vendor online again (control)", "vendor")
open(os.path.join(d, "plugins", P + "@v1.1.0", "main.t1"), "a").write("x")
refused(d, "PkgHashMismatch", "vendored tree edited", "verify")
ok(d, "vendor repairs a tampered tree", "vendor")
ok(d, "verify after repair (control)", "verify")
# tidy
d = nb("tidy")
ok(d, "add geom v1.0.0", "add", P + "@v1.0.0")
open(os.path.join(d, "plugins.req"), "w").write("")
ok(d, "tidy with no requirements", "tidy", proxy="off")
check(lockof(d) == "" and vendored(d) == [], "tidy drops unreachable lock entries and trees")

# ---- 9 unreachable ---------------------------------------------------------------------------------------------------
d = nb("unreach")
refused(d, "PkgUnreachable", "git source unreachable", "add", "example.test/acme/ghost@v1.0.0", base=os.path.join(T, "no-such-base"))
rc, err = run(d, "add", "example.test/acme/ghost@v1.0.0", base=os.path.join(T, "no-such-base"), proxy="file://%s/none,direct" % T)
check(rc == 2 and "none" in err and "direct" in err, "PkgUnreachable lists each attempt")

# ---- 10 mirror -------------------------------------------------------------------------------------------------------
M = os.path.join(T, "mirror")
d = nb("mirsrc")
ok(d, "add A (with dependency B)", "add", A)
ok(d, "mirror <dir>", "mirror", M)
check(os.path.isfile(os.path.join(M, A, "@v", "list")) and os.path.isfile(os.path.join(M, B, "@v", "v1.2.0.tar")), "mirror layout <path>/@v/{list,<ver>.info,<ver>.tar}")
dm = nb("mirdst")
os.makedirs(dm)
shutil.copy(os.path.join(d, "plugins.req"), dm)
shutil.copy(os.path.join(d, "plugins.lock"), dm)
nogit = os.path.join(T, "no-git")
ok(dm, "vendor from the mirror with git unreachable", "vendor", proxy="file://%s,off" % M, base=nogit)
check(open(os.path.join(dm, "plugins.lock")).read() == lockof(d) and vendored(dm) == vendored(d), "mirror vendoring gives the same lock and trees")
ok(dm, "verify mirror-vendored notebook", "verify", proxy="off")
dn = nb("miradd")
ok(dn, "add through the mirror only", "add", A, proxy="file://%s,off" % M, base=nogit)
check(lockof(dn) == lockof(d), "add via mirror gives the same lock as add via git (cross-host equality)")
# negative controls
shutil.rmtree(os.path.join(dm, "plugins"))
tarp = os.path.join(M, B, "@v", "v1.2.0.tar")
good = open(tarp, "rb").read()
import io, tarfile
bio = io.BytesIO()
with tarfile.open(fileobj=bio, mode="w") as tf:
    for nm, data in (("plugin.mod", mod(B).encode()), ("LICENSE", b"licence text\n"), ("main.t1", b"TAMPERED\n")):
        ti = tarfile.TarInfo(nm); ti.size = len(data); tf.addfile(ti, io.BytesIO(data))
open(tarp, "wb").write(bio.getvalue())
refused(dm, "PkgHashMismatch", "tampered mirror tar", "vendor", proxy="file://%s,off" % M, base=nogit)
check(vendored(dm) == [], "tampered mirror: nothing vendored")
open(tarp, "wb").write(good)
ok(dm, "restored mirror vendors again (control)", "vendor", proxy="file://%s,off" % M, base=nogit)
shutil.rmtree(os.path.join(dm, "plugins"))
os.remove(os.path.join(M, A, "@v", "v1.0.0.tar"))
refused(dm, "PkgUnreachable", "mirror lacks a tar, then off", "vendor", proxy="file://%s,off" % M, base=nogit)
# unsafe tar member
bio = io.BytesIO()
with tarfile.open(fileobj=bio, mode="w") as tf:
    ti = tarfile.TarInfo("../evil"); ti.size = 1; tf.addfile(ti, io.BytesIO(b"x"))
open(os.path.join(M, A, "@v", "v1.0.0.tar"), "wb").write(bio.getvalue())
refused(dm, "PkgBadTree", "tar member with ..", "vendor", proxy="file://%s,off" % M, base=nogit)

# ---- 11 path escaping, subdir packages ------------------------------------------------------------------------------
Q = "example.test/Acme/MixedCase"
mkrepo("example.test/Acme/MixedCase", [("v1.0.0", pkg(Q, "m"))])
d = nb("case")
ok(d, "add upper-case path", "add", Q)
check(os.path.isdir(os.path.join(d, "plugins", "example.test/!acme/!mixed!case@v1.0.0")), "upper-case escaped as !x in the vendored path")
S = "example.test/acme/mono/tools/fmt"
mkrepo("example.test/acme/mono", [("v1.0.0", pkg(S, "s"))], sub="tools/fmt")
d = nb("sub")
ok(d, "add subdir package (tag tools/fmt/v1.0.0)", "add", S)
check(lockof(d).split()[1] == "v1.0.0" and os.path.isfile(os.path.join(d, "plugins", S + "@v1.0.0", "plugin.mod")), "subdir package resolved by sub/ prefixed tag")

# ---- 13 R1: path traversal and symlinks ---------------------------------------------------------------------------
def linkrepo(root, files, links):
    """repo with tag v1.0.0 whose tree also holds symlinks {relpath: target}"""
    w, bare = mkrepo(root, [("v1.0.0", files)])
    for rel, tgt in links.items():
        os.makedirs(os.path.dirname(os.path.join(w, rel)) or w, exist_ok=True)
        os.symlink(tgt, os.path.join(w, rel))
    git("add", "-A", cwd=w)
    git("commit", "-q", "--amend", "-m", "v1.0.0", cwd=w)
    git("tag", "-f", "v1.0.0", cwd=w)
    git("push", "-q", "--force", bare, "HEAD:refs/heads/master", "refs/tags/v1.0.0", cwd=w)
    return w


OUT = os.path.join(T, "outside")
os.makedirs(OUT)
open(os.path.join(OUT, "secret"), "w").write("s\n")
for seg, nm in (("..", "dotdot"), (".", "dot")):
    d = nb(nm)
    refused(d, "PkgPathMismatch", "module path with %r segment" % seg, "add", "example.test/acme/%s@v1.0.0" % seg)
    refused(d, "PkgPathMismatch", "module path with %r as subdir segment" % seg, "add", "example.test/acme/geom/%s@v1.0.0" % seg)
refused(nb("empty"), "PkgPathMismatch", "module path with empty segment", "add", "example.test/acme//geom@v1.0.0")
refused(nb("abs"), "PkgPathMismatch", "absolute module path", "add", "/example.test/acme/geom@v1.0.0")
refused(nb("bsl"), "PkgPathMismatch", "backslash in module path", "add", "example.test\\acme\\geom@v1.0.0")
d = nb("tamper-req")
os.makedirs(d)
open(os.path.join(d, "plugins.req"), "w").write("require example.test/acme/../../x v1.0.0\n")
refused(d, "PkgPathMismatch", "plugins.req with .. segment", "update")
open(os.path.join(d, "plugins.req"), "w").write("")
open(os.path.join(d, "plugins.lock"), "w").write("example.test/acme/.. v1.0.0 h1:00 MIT -\n")
refused(d, "PkgPathMismatch", "plugins.lock with .. segment", "mirror", os.path.join(T, "mout"))
check(not os.path.exists(os.path.join(T, "mout")), "no mirror output written for a tampered lock")

LK = "example.test/acme/lnk"
good = pkg(LK, "l")
linkrepo("example.test/acme/lnk", good, {})
ok(nb("lnk-ctl"), "add repo without links (control)", "add", LK + "@v1.0.0")
for nm, links, what in (
        ("flink", {"alias.t1": "main.t1"}, "file symlink in module tree"),
        ("dlink", {"sub/alias": "."}, "directory symlink inside module tree"),
        ("dlink-out", {"escape": OUT}, "directory symlink pointing outside the root"),
        ("flink-out", {"leak": os.path.join(OUT, "secret")}, "file symlink pointing outside the root")):
    linkrepo("example.test/acme/lnk", dict(good, **{"sub/keep": "k\n"}), links)
    d = nb(nm)
    refused(d, "PkgBadTree", what, "add", LK + "@v1.0.0")
    check(lockof(d) is None and vendored(d) == [] and not os.path.exists(os.path.join(d, "plugins", LK + "@v1.0.0")), what + ": nothing vendored")
# hash time: a link planted in an already vendored tree is refused, not silently ignored
linkrepo("example.test/acme/lnk", good, {})
d = nb("lnk-vfy")
ok(d, "add (control for planted link)", "add", LK + "@v1.0.0")
ok(d, "verify clean (control)", "verify")
vt = os.path.join(d, "plugins", LK + "@v1.0.0")
os.symlink(OUT, os.path.join(vt, "planted"))
refused(d, "PkgBadTree", "verify with a planted directory symlink", "verify")
os.remove(os.path.join(vt, "planted"))
os.symlink("main.t1", os.path.join(vt, "planted"))
refused(d, "PkgBadTree", "verify with a planted file symlink", "verify")
os.remove(os.path.join(vt, "planted"))
os.symlink(OUT, os.path.join(vt, ".git"))
refused(d, "PkgBadTree", "verify with a .git directory symlink", "verify")
os.remove(os.path.join(vt, ".git"))
ok(d, "verify after removing links (control)", "verify")
# nested .git content is never copied (it is not hashed)
linkrepo("example.test/acme/lnk", dict(good, **{"x/.git/hook": "evil\n"}), {})
d = nb("lnk-git")
ok(d, "add repo with nested .git dir", "add", LK + "@v1.0.0")
check(not os.path.exists(os.path.join(d, "plugins", LK + "@v1.0.0", "x", ".git")), "nested .git (unhashed) is not copied into the vendored tree")

# ---- 12 usage --------------------------------------------------------------------------------------------------------
rc, _ = run(nb("usage"), "frobnicate")
check(rc == 64, "unknown command: usage, rc 64")
rc, _ = run(nb("usage"), "add")
check(rc == 64, "add without a path: usage, rc 64")

# cross-implementation vector: the same tree hashed by kernel/isas.mjs treeHash (UTF-8 byte order; UTF-16 order differs here)
import importlib.util
_s = importlib.util.spec_from_file_location("isas_pkg", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "kernel", "isas-pkg.py"))
_m = importlib.util.module_from_spec(_s); _s.loader.exec_module(_m)
V = os.path.join(T, "vec"); os.makedirs(V)
for name, body in (("\uff61", b"a"), ("\U0001F600", b"b"), ("Z", b"c")): open(os.path.join(V, name), "wb").write(body)
check(_m.tree_hash(V) == "h1:57d3aae20dcd495f793dcb9b27413d443d8f228c640ceb511599200e7419a8b6", "tree_hash sorts by UTF-8 bytes: matches kernel/isas.mjs treeHash on a non-BMP vector")

shutil.rmtree(T, ignore_errors=True)
print("%d checks, %d passed, %d failed" % (n, n - bad, bad))
sys.exit(1 if bad else 0)
