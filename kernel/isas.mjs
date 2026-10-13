// SPDX-License-Identifier: AGPL-3.0-only
// .isas notebook format, version 1: reference parser and writer. Pure functions, no I/O; node and browser.
// The marker words come from kernel/isas-names.mjs (copied from the format spec by tools/gen-isas-names.py).
import { BAR, CELL, OUTPUT } from './isas-names.mjs';
import { RESULT, sniff, EXT, sha256hex, b64, unb64, partBytes } from './parts.mjs';
import { sanitizeSvg } from './svg.mjs';

export const MAJOR = 1;
export class IsasError extends Error {
  constructor(name, why, line) { super(`${name}${line ? ` (line ${line})` : ''}: ${why}`); this.name = name; this.why = why; this.line = line ?? null; }
}
const CELL_RE = new RegExp(`^${BAR} ${CELL} (\\d+) (code|note|plugin) ${BAR}$`);
const OUT_LINE = `${BAR} ${OUTPUT} ${BAR}`;
const isMarkerish = (l) => l.startsWith(`${BAR} ${CELL} `) || l.startsWith(`${BAR} ${OUTPUT} `) || l === OUT_LINE;

// ---- plugin units (amendment; docs/ISAS-FORMAT.md "Plugins") ----
// Header `plugin: {json}` (one manifest per line) and `lock: <path> <vX.Y.Z> h1:<tree sha256> <licence> <commit>`; a `plugin` cell holds
// the source of an embedded unit. checkPlugins is the structural check shared by parse and write; resolvePlugins checks the bytes.
export const PLUGIN_LICENCES = ['AGPL-3.0-only', 'MIT', 'BSD-3-Clause', 'Apache-2.0', 'CC0-1.0'];
const VER_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, HEX = /^[0-9a-f]{64}$/, COMMIT_RE = /^[0-9a-f]{40}$/;
const PATH_SEG = /^[A-Za-z0-9._~-]+$/;
const sound = (seg) => seg.length > 0 && seg !== '.' && seg !== '..' && !/[\\:\x00-\x1f\x7f]/.test(seg);
const bad = (name, why, line) => new IsasError(name, why, line);
const escPath = (p) => p.replace(/[A-Z]/g, (c) => '!' + c.toLowerCase());   // Go module path escaping: !x stands for X
function checkLicence(l, what, line) {
  if (typeof l !== 'string' || !l) throw bad('IsasPluginBadManifest', `${what}: licence missing`, line);
  if (/(^|[-.])NC([-.]|$)/.test(l) || !PLUGIN_LICENCES.includes(l)) throw bad('IsasPluginLicenceRefused', `${what}: licence ${JSON.stringify(l)} is not on the allowlist (${PLUGIN_LICENCES.join(', ')}); non-commercial licences are refused`, line);
}
// a module path: host.tld/owner/repo[/subdir][/vN], no scheme, no `..`; N >= 2 only
function checkModPath(path, version, what, line) {
  if (typeof path !== 'string') throw bad('IsasPluginBadManifest', `${what}: path must be a string`, line);
  const segs = path.split('/');
  if (segs.length < 3 || !segs.every((x) => PATH_SEG.test(x) && x !== '.' && x !== '..') || !segs[0].includes('.')) throw bad('IsasPluginBadManifest', `${what}: path must be host/owner/repo[/subdir][/vN] without a scheme`, line);
  const mv = /^v(\d+)$/.exec(segs[segs.length - 1]), major = Number(version.slice(1).split('.')[0]);
  if (mv && (Number(mv[1]) < 2 || Number(mv[1]) !== major)) throw bad('IsasPluginBadManifest', `${what}: a /vN path suffix needs N >= 2 and equal to the version's major`, line);
  if (!mv && major >= 2) throw bad('IsasPluginBadManifest', `${what}: version ${version} needs a /v${major} path suffix`, line);
}
// src: `embedded:<cell N>` or <x>.isas.d/plugins/<rest>, each segment sound (no empty, `.`, `..`, `\`, `:`, control character)
function checkSrc(src, what, line) {
  if (typeof src !== 'string') throw bad('IsasPluginBadManifest', `${what}: src must be a string`, line);
  const segs = src.split('/');
  if (segs.length < 3 || !segs.every(sound) || !segs[0].endsWith('.isas.d') || segs[0] === '.isas.d' || segs[1] !== 'plugins') throw bad('IsasPluginBadManifest', `${what}: src must be <name>.isas.d/plugins/<file> with no .., scheme or absolute path`, line);
  return segs;
}
export function parseLockLine(l, line) {
  const f = l.split(' ');
  if (f.length !== 5 || !VER_RE.test(f[1]) || !/^h1:[0-9a-f]{64}$/.test(f[2]) || !COMMIT_RE.test(f[4])) throw bad('IsasPluginBadManifest', 'a lock line is `<path> <vX.Y.Z> h1:<64 hex> <licence> <40 hex commit>`', line);
  checkModPath(f[0], f[1], 'lock', line); checkLicence(f[3], 'lock', line);
  return { path: f[0], version: f[1], h1: f[2].slice(3), licence: f[3], commit: f[4] };
}
export const parseLock = (text) => text.split('\n').filter((l) => l !== '').map((l, k) => parseLockLine(l, k + 1));
export const formatLock = (entries) => entries.map((e) => `${e.path} ${e.version} h1:${e.h1} ${e.licence} ${e.commit}\n`).join('');
// header [[key, value]] -> { plugins: [manifest], lock: [entry] }; throws the IsasPlugin* refusals. `first`: line number of header[0], or null.
function readPluginHeader(header, first) {
  const plugins = [], lock = [];
  header.forEach(([k, v], idx) => {
    const line = first === null ? undefined : first + idx;
    if (k === 'lock') { lock.push(parseLockLine(v, line)); return; }
    if (k !== 'plugin') return;
    let j; try { j = JSON.parse(v); } catch { throw bad('IsasPluginBadManifest', 'plugin: the value is not JSON', line); }
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw bad('IsasPluginBadManifest', 'plugin: the value must be a JSON object', line);
    const what = `plugin ${typeof j.name === 'string' ? JSON.stringify(j.name) : '#' + (plugins.length + 1)}`;
    if (typeof j.name !== 'string' || !sound(j.name) || /[\s/@]/.test(j.name)) throw bad('IsasPluginBadManifest', `${what}: name must be a module identifier`, line);
    if (typeof j.version !== 'string' || !VER_RE.test(j.version)) throw bad('IsasPluginBadManifest', `${what}: version must be an ASCII vMAJOR.MINOR.PATCH`, line);
    if (typeof j.sha256 !== 'string' || !HEX.test(j.sha256)) throw bad('IsasPluginBadManifest', `${what}: sha256 must be 64 lower-case hex digits`, line);
    if (j.path !== undefined) checkModPath(j.path, j.version, what, line);
    checkLicence(j.licence, what, line);
    if (typeof j.src !== 'string') throw bad('IsasPluginBadManifest', `${what}: src must be a string`, line);
    const em = /^embedded:(\d+)$/.exec(j.src);
    if (em) { if (!/^[1-9]\d*$/.test(em[1])) throw bad('IsasPluginBadManifest', `${what}: embedded cell number`, line); }
    else {
      const segs = checkSrc(j.src, what, line), want = j.path === undefined ? `${j.name}@${j.version}.t1` : `${escPath(j.path)}@${j.version}`;
      const rest = segs.slice(2).join('/');
      if (j.path === undefined ? rest !== want : !(rest.startsWith(want + '/') && rest.length > want.length + 1)) throw bad('IsasPluginBadManifest', `${what}: src must be ${segs[0]}/plugins/${want}${j.path === undefined ? '' : '/<file>'}`, line);
    }
    if (j.requires !== undefined && !(Array.isArray(j.requires) && j.requires.every((x) => typeof x === 'string') && new Set(j.requires).size === j.requires.length)) throw bad('IsasPluginBadManifest', `${what}: requires must be a list of distinct names`, line);
    if (j.exports !== undefined && !(Array.isArray(j.exports) && j.exports.every((x) => typeof x === 'string'))) throw bad('IsasPluginBadManifest', `${what}: exports must be a list of names`, line);
    if (j.frag !== undefined) {
      const f = j.frag;
      if (!f || typeof f !== 'object' || !HEX.test(f.sha256 ?? '') || !HEX.test(f.stage1_sha256 ?? '')) throw bad('IsasPluginBadManifest', `${what}: frag needs src, sha256 and stage1_sha256`, line);
      checkSrc(f.src, `${what} frag`, line);
    }
    plugins.push(j);
  });
  return { plugins, lock };
}
// the structural check: manifests are well formed, every embedded one names a plugin cell (each cell used once), every plugin cell is named
function checkPlugins(header, kinds, first) {
  const { plugins, lock } = readPluginHeader(header, first);
  const used = new Set();
  for (const p of plugins) {
    const em = /^embedded:(\d+)$/.exec(p.src); if (!em) continue;
    const n = Number(em[1]);
    if (kinds[n - 1] !== 'plugin') throw bad('IsasPluginMissing', `plugin ${JSON.stringify(p.name)}: ${p.src} is not a plugin cell`);
    if (used.has(n)) throw bad('IsasPluginBadManifest', `plugin ${JSON.stringify(p.name)}: cell ${n} is already the source of another plugin`);
    used.add(n);
  }
  kinds.forEach((k, ci) => { if (k === 'plugin' && !used.has(ci + 1)) throw bad('IsasPluginBadManifest', `cell ${ci + 1} is a plugin cell that no plugin header names`); });
  return { plugins, lock };
}
export const pluginsOf = (nb) => readPluginHeader(nb.header, null);
// go.sum h1: sha256 over the sorted lines `sha256(file)  <relpath>\n`. `entries`: Map relpath -> bytes (the tree minus .git).
export async function treeHash(entries) {
  const lines = [];
  for (const [rel, bytes] of entries) lines.push([rel, `${await sha256hex(bytes)}  ${rel}\n`]);
  // Go/Python rule: order by the UTF-8 bytes of the path, not by UTF-16 code units (they differ above U+FFFF).
  const enc = new TextEncoder(), key = new Map(lines.map(([r]) => [r, enc.encode(r)]));
  const cmp = (x, y) => { for (let i = 0; i < x.length && i < y.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return x.length - y.length; };
  lines.sort((a, b) => cmp(key.get(a[0]), key.get(b[0])));
  return sha256hex(new TextEncoder().encode(lines.map((x) => x[1]).join('')));
}
// Check the bytes of every plugin. `files`: Map of full path -> bytes (side files, vendored trees, `<name>.isas.d/plugins.lock`).
// Returns { problems: [{ plugin, name, ... }], sources: Map(plugin name -> source bytes, unit plugins only) }.
export async function resolvePlugins(nb, files, { name } = {}) {
  const { plugins, lock: hl } = pluginsOf(nb), problems = [], sources = new Map(), enc = new TextEncoder();
  const lockKeys = [...files.keys()].filter((k) => name === undefined ? /(^|\/)[^/]+\.isas\.d\/plugins\.lock$/.test(k) : k === `${name}.isas.d/plugins.lock`);
  let lock = [...hl];
  try { for (const k of lockKeys) lock.push(...parseLock(new TextDecoder().decode(files.get(k)))); }
  catch (e) { return { problems: [{ plugin: null, name: e.name, why: e.why }], sources }; }
  for (const a of lock) for (const b of lock) if (a.path === b.path && a.version === b.version && (a.h1 !== b.h1 || a.licence !== b.licence)) return { problems: [{ plugin: null, name: 'IsasPluginLockMismatch', why: `two lock entries for ${a.path} ${a.version} disagree` }], sources };
  for (const p of plugins) {
    const fail = (n, why) => problems.push({ plugin: p.name, name: n, why });
    let bytes; const em = /^embedded:(\d+)$/.exec(p.src);
    if (em) bytes = enc.encode(nb.cells[Number(em[1]) - 1].body);
    else {
      bytes = files.get(p.src);
      if (!bytes) { fail('IsasPluginMissing', `${p.src} is not loaded`); continue; }
      if (bytes.length > MAX_SIDE) { fail('IsasTooLarge', p.src); continue; }
    }
    let want = p.sha256;
    if (p.path !== undefined) {
      const e = lock.find((x) => x.path === p.path && x.version === p.version);
      if (!e) { fail('IsasPluginMissing', `no lock entry for ${p.path} ${p.version}`); continue; }
      if (e.licence !== p.licence) { fail('IsasPluginLockMismatch', `lock licence ${e.licence} differs from the manifest's ${p.licence}`); continue; }
      if (!em) {   // the vendored tree is the trust unit: manifest sha256 = lock h1 = tree hash
        const dir = `${p.src.split('/')[0]}/plugins/${escPath(p.path)}@${p.version}/`, tree = new Map();
        for (const [k, v] of files) if (k.startsWith(dir)) tree.set(k.slice(dir.length), v);
        if (p.sha256 !== e.h1 || (await treeHash(tree)) !== e.h1) { fail('IsasPluginLockMismatch', `${dir} does not hash to the lock's h1:${e.h1}`); continue; }
        want = null;
      }
    }
    if (want !== null && (await sha256hex(bytes)) !== want) { fail('IsasPluginHashMismatch', em ? `cell ${em[1]} does not match sha256` : `${p.src} does not match sha256`); continue; }
    sources.set(p.name, bytes);
  }
  return { problems, sources };
}

// ---- the output encoding lives in encodeOutput / decodeOutput only ----
// An output is an array of parts (kernel/parts.mjs). After the OUTPUT marker: ONE JSON line per part, each with a MIME `type`.
export const MAX_ISAS = 32 << 20, MAX_SIDE = 16 << 20;  // a larger .isas (characters) or side file (octets) is IsasTooLarge, not read
export const SIDE_LIMIT = 64 * 1024;            // parts under 64 KB are embedded; larger images go to <name>.isas.d/
const SRC_RE = /^[^/\\]+\.isas\.d\/\d+\.(png|jpg|svg)$/;
const isNum = (v) => v === null || Number.isInteger(v);
export function encodeOutput(parts) {
  return parts.map((p) => {
    switch (p.type) {
      case 'text/plain': return JSON.stringify({ type: p.type, data: p.data });
      case 'image/png': case 'image/jpeg': case 'image/svg+xml':
        return JSON.stringify(p.src !== undefined && p.data === undefined
          ? { type: p.type, src: p.src, sha256: p.sha256 }
          : p.type === 'image/svg+xml' ? { type: p.type, data: p.data } : { type: p.type, encoding: 'base64', data: p.data });
      case RESULT: return JSON.stringify({ type: p.type, status: p.status, steps_compile: p.steps_compile, steps_run: p.steps_run, refusal: p.refusal ?? null });
      default: throw new IsasError('IsasUnsupportedType', `part type ${JSON.stringify(p.type)}`);
    }
  });
}
export function decodeOutput(lines, at) {
  if (!lines.length) throw new IsasError('IsasBadOutput', 'no output part after the output marker', at);
  return lines.map((l, k) => {
    const line = at + k;
    let j; try { j = JSON.parse(l); } catch { throw new IsasError('IsasBadOutput', 'an output line is not JSON', line); }
    if (!j || typeof j !== 'object' || typeof j.type !== 'string') throw new IsasError('IsasBadOutput', 'an output part needs a string `type`', line);
    const bad = (why) => new IsasError('IsasBadOutput', `${j.type}: ${why}`, line);
    switch (j.type) {
      case 'text/plain':
        if (typeof j.data !== 'string') throw bad('data must be a string');
        return { type: j.type, data: j.data };
      case 'image/png': case 'image/jpeg': case 'image/svg+xml': {
        const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' }[j.type];
        if (typeof j.src === 'string') {
          if (!SRC_RE.test(j.src) || !j.src.endsWith('.' + ext)) throw bad('src must be <name>.isas.d/<n>.' + ext);
          if (typeof j.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(j.sha256)) throw bad('a side file needs its sha256');
          return { type: j.type, src: j.src, sha256: j.sha256 };
        }
        if (typeof j.data !== 'string') throw bad('data must be a string');
        if (j.type === 'image/svg+xml') { const s = sanitizeSvg(j.data); if (s === null) throw bad('not an SVG document'); return { type: j.type, data: s }; }
        if (j.encoding !== 'base64' || !/^[A-Za-z0-9+/]*={0,2}$/.test(j.data)) throw bad('encoding must be base64');
        if (sniff(unb64(j.data)) !== j.type) throw bad('the bytes are not a ' + ext.toUpperCase() + ' image');
        return { type: j.type, encoding: 'base64', data: j.data };
      }
      case RESULT: {
        const r = j.refusal;
        if (!(isNum(j.status) && isNum(j.steps_compile) && isNum(j.steps_run) && (r === null || (r && typeof r.name === 'string' && isNum(r.code))))) throw bad('status, steps_compile, steps_run or refusal has the wrong type');
        return { type: j.type, status: j.status, steps_compile: j.steps_compile, steps_run: j.steps_run, refusal: r };
      }
      default: throw new IsasError('IsasUnsupportedType', `part type ${JSON.stringify(j.type)} (v1 knows text/plain, image/png, image/jpeg, image/svg+xml and ${RESULT})`, line);
    }
  });
}
export { partsOf as outputOf, textOf, resultOf, sameParts as sameOutput } from './parts.mjs';
// ----

// text -> { version, header: [[key, value], ...] (unknown keys kept, in order), cells: [{ kind, body, output|null }] }
export function parse(text) {
  if (text.length > MAX_ISAS) throw new IsasError('IsasTooLarge', `the file is over ${MAX_ISAS >> 20} Mi characters`, 1);
  const lines = text.split('\n'); if (lines[lines.length - 1] === '') lines.pop();
  if (!lines.length || !/^ISAS \d+$/.test(lines[0])) throw new IsasError('IsasNotAnIsasFile', 'line 1 must be exactly `ISAS <major>`', 1);
  const version = Number(lines[0].slice(5));
  if (version !== MAJOR) throw new IsasError('IsasUnknownMajorVersion', `this reader knows major version ${MAJOR}, the file is ${version}`, 1);
  const header = []; let i = 1;
  for (; i < lines.length && !isMarkerish(lines[i]); i++) {
    const m = /^([A-Za-z0-9_]+): ?(.*)$/.exec(lines[i]);
    if (!m) throw new IsasError('IsasMalformedHeader', 'a header line must be `key: value` with an ASCII key', i + 1);
    header.push([m[1], m[2]]);
  }
  const cells = [];
  while (i < lines.length) {
    const m = CELL_RE.exec(lines[i]);
    if (!m) throw new IsasError('IsasBadCellMarker', `expected \`${BAR} ${CELL} N code|note|plugin ${BAR}\``, i + 1);
    if (Number(m[1]) !== cells.length + 1) throw new IsasError('IsasCellNumberOutOfOrder', `cell ${m[1]} where ${cells.length + 1} was expected`, i + 1);
    const body = []; i++;
    while (i < lines.length && !isMarkerish(lines[i])) body.push(lines[i++]);
    let output = null;
    if (i < lines.length && lines[i] === OUT_LINE) {
      if (m[2] === 'plugin') throw new IsasError('IsasPluginOutput', 'a plugin cell has no output', i + 1);
      if (m[2] !== 'code') throw new IsasError('IsasOutputOnNote', 'a note cell has no output', i + 1);
      const at = i + 1, outLines = []; i++;
      while (i < lines.length && !isMarkerish(lines[i])) outLines.push(lines[i++]);
      output = decodeOutput(outLines, at);
    }
    cells.push({ kind: m[2], body: body.join('\n'), output });
  }
  checkPlugins(header, cells.map((c) => c.kind), 2);
  return { version, header, cells };
}

// -> { text, files: Map(path -> bytes) }. Images under 64 KB are embedded; larger ones go to <name>.isas.d/<n>.<ext> and are
// referenced by sha256, unless embedAll. `name` is the file's base name (without .isas).
export async function write(nb, { embedAll = false, name = 'notebook' } = {}) {
  const o = [`ISAS ${MAJOR}`], files = new Map(); let n = 0;
  checkPlugins(nb.header, nb.cells.map((c) => c.kind), null);
  for (const [k, v] of nb.header) {
    if (!/^[A-Za-z0-9_]+$/.test(k) || /\n/.test(v)) throw new IsasError('IsasUnwritableHeader', `header ${JSON.stringify(k)}`);
    o.push(`${k}: ${v}`);
  }
  for (const [ci, c] of nb.cells.entries()) {
    if (c.kind !== 'code' && c.kind !== 'note' && c.kind !== 'plugin') throw new IsasError('IsasUnknownCellKind', `cell ${ci + 1}: ${c.kind}`);
    o.push(`${BAR} ${CELL} ${ci + 1} ${c.kind} ${BAR}`);
    const body = c.body === '' ? [] : c.body.split('\n');
    for (const l of body) if (isMarkerish(l)) throw new IsasError('IsasUnwritableBody', `cell ${ci + 1} has a line that reads as a marker`);
    o.push(...body);
    if (!c.output) continue;
    if (c.kind === 'plugin') throw new IsasError('IsasPluginOutput', `cell ${ci + 1}`);
    if (c.kind !== 'code') throw new IsasError('IsasOutputOnNote', `cell ${ci + 1}`);
    const parts = [];
    for (const p of c.output) {
      const isImg = p.type === 'image/png' || p.type === 'image/jpeg' || p.type === 'image/svg+xml';
      if (!isImg) { parts.push(p); continue; }
      const bytes = partBytes(p);
      if (embedAll) {
        if (!bytes) throw new IsasError('IsasMissingSideFile', `cell ${ci + 1}: ${p.src} is not loaded, so it cannot be embedded`);
        parts.push(p.type === 'image/svg+xml' ? { type: p.type, data: new TextDecoder().decode(bytes) } : { type: p.type, encoding: 'base64', data: b64(bytes) });
      } else if (bytes && bytes.length >= SIDE_LIMIT) {
        const path = `${name}.isas.d/${++n}.${EXT[p.type]}`; files.set(path, bytes);
        parts.push({ type: p.type, src: path, sha256: await sha256hex(bytes) });
      } else if (bytes) parts.push(p.type === 'image/svg+xml' ? { type: p.type, data: new TextDecoder().decode(bytes) } : { type: p.type, encoding: 'base64', data: b64(bytes) });
      else parts.push(p);   // an unloaded side file stays a reference
    }
    o.push(OUT_LINE, ...encodeOutput(parts));
  }
  return { text: o.join('\n') + '\n', files };
}

// Load side files for the src parts of a parsed notebook. `files`: Map of path or base name -> bytes. Each src part gets
// `bytes` (verified against its sha256) or `problem` ('IsasMissingSideFile' | 'IsasSideFileHashMismatch'). Returns the problems.
export async function resolveSideFiles(nb, files) {
  const problems = [];
  for (const [ci, c] of nb.cells.entries()) for (const p of c.output ?? []) {
    if (p.src === undefined) continue;
    const bytes = files.get(p.src) ?? files.get(p.src.split('/').pop());
    if (bytes && bytes.length > MAX_SIDE) { p.problem = 'IsasTooLarge'; problems.push({ cell: ci + 1, name: p.problem, src: p.src }); continue; }
    if (!bytes) { p.problem = 'IsasMissingSideFile'; problems.push({ cell: ci + 1, name: p.problem, src: p.src }); continue; }
    if ((await sha256hex(bytes)) !== p.sha256) { p.problem = 'IsasSideFileHashMismatch'; problems.push({ cell: ci + 1, name: p.problem, src: p.src }); continue; }
    if (p.type === 'image/svg+xml') { const s = sanitizeSvg(new TextDecoder().decode(bytes)); if (s === null) { p.problem = 'IsasBadOutput'; continue; } p.bytes = new TextEncoder().encode(s); }
    else if (sniff(bytes) !== p.type) { p.problem = 'IsasBadOutput'; problems.push({ cell: ci + 1, name: p.problem, src: p.src }); continue; }
    else p.bytes = bytes;
    delete p.problem;
  }
  return problems;
}
