// .isas notebook format, version 1: reference parser and writer. Pure functions, no I/O; node and browser.
// The marker words come from kernel/isas-names.mjs (copied from the format spec by tools/gen-isas-names.py).
import { BAR, CELL, OUTPUT } from './isas-names.mjs';
import { REFUSALS } from './refusals.mjs';

export const MAJOR = 1;
export class IsasError extends Error {
  constructor(name, why, line) { super(`${name}${line ? ` (line ${line})` : ''}: ${why}`); this.name = name; this.why = why; this.line = line ?? null; }
}
const CELL_RE = new RegExp(`^${BAR} ${CELL} (\\d+) (code|note) ${BAR}$`);
const OUT_LINE = `${BAR} ${OUTPUT} ${BAR}`;
const isMarkerish = (l) => l.startsWith(`${BAR} ${CELL} `) || l.startsWith(`${BAR} ${OUTPUT} `) || l === OUT_LINE;

// ---- the output encoding lives in these two functions only ------------------------------------------------------
// out = { status, steps_compile, steps_run, stdout_b64, refusal: {name, code} | null }.  encodeOutput returns the
// lines written after the OUTPUT marker; decodeOutput takes those lines (up to the next cell marker) back.
export function encodeOutput(out) {
  return [JSON.stringify({ status: out.status, steps_compile: out.steps_compile, steps_run: out.steps_run, stdout_b64: out.stdout_b64, refusal: out.refusal ?? null })];
}
export function decodeOutput(lines, at) {
  if (lines.length !== 1) throw new IsasError('IsasBadOutput', `expected one JSON line after the output marker, found ${lines.length}`, at);
  let j; try { j = JSON.parse(lines[0]); } catch { throw new IsasError('IsasBadOutput', 'the output line is not JSON', at); }
  const num = (v) => v === null || Number.isInteger(v);
  const r = j?.refusal;
  const ok = j && typeof j === 'object' && num(j.status) && num(j.steps_compile) && num(j.steps_run) && typeof j.stdout_b64 === 'string'
    && (r === null || (r && typeof r.name === 'string' && num(r.code)));
  if (!ok) throw new IsasError('IsasBadOutput', 'the output JSON lacks status, steps_compile, steps_run, stdout_b64 or refusal of the right type', at);
  return { status: j.status, steps_compile: j.steps_compile, steps_run: j.steps_run, stdout_b64: j.stdout_b64, refusal: r };
}
// a result row of kernel/core.mjs -> the saved-output shape
export function outputOf(row) {
  if (row.error) return { status: null, steps_compile: null, steps_run: null, stdout_b64: '', refusal: { name: row.error, code: null } };
  const bytes = row.output_hex.match(/../g)?.map((h) => parseInt(h, 16)) ?? [];
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return { status: row.status, steps_compile: row.steps_compile, steps_run: row.steps_run, stdout_b64: btoa(bin),
    refusal: REFUSALS[row.status] ? { name: REFUSALS[row.status], code: row.status } : null };
}
export const stdoutOf = (out) => { const bin = atob(out.stdout_b64); return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))); };
export const sameOutput = (a, b) => JSON.stringify(encodeOutput(a)) === JSON.stringify(encodeOutput(b));
// -------------------------------------------------------------------------------------------------------------------

// text -> { version, header: [[key, value], ...] (unknown keys kept, in order), cells: [{ kind, body, output|null }] }
export function parse(text) {
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

export function write(nb) {
  const o = [`ISAS ${MAJOR}`];
  for (const [k, v] of nb.header) {
    if (!/^[A-Za-z0-9_]+$/.test(k) || /\n/.test(v)) throw new IsasError('IsasUnwritableHeader', `header ${JSON.stringify(k)}`);
    o.push(`${k}: ${v}`);
  }
  nb.cells.forEach((c, n) => {
    if (c.kind !== 'code' && c.kind !== 'note') throw new IsasError('IsasUnknownCellKind', `cell ${n + 1}: ${c.kind}`);
    o.push(`${BAR} ${CELL} ${n + 1} ${c.kind} ${BAR}`);
    const body = c.body === '' ? [] : c.body.split('\n');
    for (const l of body) if (isMarkerish(l)) throw new IsasError('IsasUnwritableBody', `cell ${n + 1} has a line that reads as a marker`);
    o.push(...body);
    if (c.output) { if (c.kind !== 'code') throw new IsasError('IsasOutputOnNote', `cell ${n + 1}`); o.push(OUT_LINE, ...encodeOutput(c.output)); }
  });
  return o.join('\n') + '\n';
}
