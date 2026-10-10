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
const CELL_RE = new RegExp(`^${BAR} ${CELL} (\\d+) (code|note) ${BAR}$`);
const OUT_LINE = `${BAR} ${OUTPUT} ${BAR}`;
const isMarkerish = (l) => l.startsWith(`${BAR} ${CELL} `) || l.startsWith(`${BAR} ${OUTPUT} `) || l === OUT_LINE;

// ---- the output encoding lives in encodeOutput / decodeOutput only ----------------------------------------------------
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
// -------------------------------------------------------------------------------------------------------------------

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
    if (!m) throw new IsasError('IsasBadCellMarker', `expected \`${BAR} ${CELL} N code|note ${BAR}\``, i + 1);
    if (Number(m[1]) !== cells.length + 1) throw new IsasError('IsasCellNumberOutOfOrder', `cell ${m[1]} where ${cells.length + 1} was expected`, i + 1);
    const body = []; i++;
    while (i < lines.length && !isMarkerish(lines[i])) body.push(lines[i++]);
    let output = null;
    if (i < lines.length && lines[i] === OUT_LINE) {
      if (m[2] !== 'code') throw new IsasError('IsasOutputOnNote', 'a note cell has no output', i + 1);
      const at = i + 1, outLines = []; i++;
      while (i < lines.length && !isMarkerish(lines[i])) outLines.push(lines[i++]);
      output = decodeOutput(outLines, at);
    }
    cells.push({ kind: m[2], body: body.join('\n'), output });
  }
  return { version, header, cells };
}

// -> { text, files: Map(path -> bytes) }. Images under 64 KB are embedded; larger ones go to <name>.isas.d/<n>.<ext> and are
// referenced by sha256, unless embedAll. `name` is the file's base name (without .isas).
export async function write(nb, { embedAll = false, name = 'notebook' } = {}) {
  const o = [`ISAS ${MAJOR}`], files = new Map(); let n = 0;
  for (const [k, v] of nb.header) {
    if (!/^[A-Za-z0-9_]+$/.test(k) || /\n/.test(v)) throw new IsasError('IsasUnwritableHeader', `header ${JSON.stringify(k)}`);
    o.push(`${k}: ${v}`);
  }
  for (const [ci, c] of nb.cells.entries()) {
    if (c.kind !== 'code' && c.kind !== 'note') throw new IsasError('IsasUnknownCellKind', `cell ${ci + 1}: ${c.kind}`);
    o.push(`${BAR} ${CELL} ${ci + 1} ${c.kind} ${BAR}`);
    const body = c.body === '' ? [] : c.body.split('\n');
    for (const l of body) if (isMarkerish(l)) throw new IsasError('IsasUnwritableBody', `cell ${ci + 1} has a line that reads as a marker`);
    o.push(...body);
    if (!c.output) continue;
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
