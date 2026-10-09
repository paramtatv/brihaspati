// Output parts. A saved output is an array of parts, one JSON line each, every part with a MIME `type`:
//   text/plain {data} | image/png, image/jpeg {encoding:'base64', data} or {src, sha256} | image/svg+xml {data} or {src, sha256}
//   application/x-sassembly-result {status, steps_compile, steps_run, refusal}.   No text/html in v1.
import { sanitizeSvg } from './svg.mjs';
import { REFUSALS } from './refusals.mjs';
export const RESULT = 'application/x-sassembly-result';
export const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const sha256hex = async (u8) => Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', u8)), (x) => x.toString(16).padStart(2, '0')).join('');
const dec = new TextDecoder('utf-8'), enc = new TextEncoder();
// the MIME type of a file's bytes, by magic; null for anything else
export function sniff(u8) {
  if (u8.length > 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47 && u8[4] === 0x0d && u8[5] === 0x0a && u8[6] === 0x1a && u8[7] === 0x0a) return 'image/png';
  if (u8.length > 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'image/jpeg';
  const head = dec.decode(u8.subarray(0, Math.min(u8.length, 4096))).replace(/^﻿/, '');
  const k = head.search(/<svg[\s>]/i);
  if (k >= 0 && !/<[A-Za-z]/.test(head.slice(0, k))) return 'image/svg+xml';   // only a prolog (xml, comments, DOCTYPE) before <svg
  return null;
}
export const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' };
// files [{name, bytes}] written by the program -> image parts (unknown files are returned in `ignored`)
export function imageParts(files) {
  const parts = [], ignored = [];
  for (const f of files ?? []) {
    const type = sniff(f.bytes);
    if (type === 'image/svg+xml') { const s = sanitizeSvg(dec.decode(f.bytes)); s === null ? ignored.push(f.name) : parts.push({ type, data: s }); }
    else if (type) parts.push({ type, encoding: 'base64', data: b64(f.bytes) });
    else ignored.push(f.name);
  }
  return { parts, ignored };
}
// a result row of kernel/core.mjs (+ files the program wrote) -> parts
export function partsOf(row, files = []) {
  if (row.error) return [{ type: RESULT, status: null, steps_compile: null, steps_run: null, refusal: { name: row.error, code: null } }];
  const parts = [];
  if (row.output_hex) parts.push({ type: 'text/plain', data: dec.decode(Uint8Array.from(row.output_hex.match(/../g), (h) => parseInt(h, 16))) });
  parts.push(...imageParts(files).parts);
  parts.push({ type: RESULT, status: row.status, steps_compile: row.steps_compile, steps_run: row.steps_run, refusal: REFUSALS[row.status] ? { name: REFUSALS[row.status], code: row.status } : null });
  return parts;
}
export const textOf = (parts) => parts.filter((p) => p.type === 'text/plain').map((p) => p.data).join('');
export const resultOf = (parts) => parts.find((p) => p.type === RESULT) ?? null;
export const partBytes = (p) => p.bytes ?? (p.type === 'image/svg+xml' ? enc.encode(p.data) : p.encoding === 'base64' ? unb64(p.data) : null);
export const sameParts = (a, b) => JSON.stringify(a.map(stable)) === JSON.stringify(b.map(stable));
const stable = (p) => { const { bytes, ...r } = p; return r; };
