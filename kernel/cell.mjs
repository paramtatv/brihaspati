// बृहस्पति phase 1a: compile ONE T1 cell with the pinned Stage 1 compiler image running on
// yantra-wasm, run the emitted ELF on yantra-wasm, print one JSON line.
// The native counterpart is kernel/native.sh; the two must agree on every field but wall time.
//
// usage: node kernel/cell.mjs <cell.t1> [--elf-out FILE]
// env:   STAGE1 (image path, default vendor/stage1.elf), YANTRA_WASM (default vendor/yantra_wasm.wasm)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compileAndRun, sha256 } from './core.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(readFileSync(join(root, 'kernel/pins.json'), 'utf8'));
const args = process.argv.slice(2);
const eo = args.indexOf('--elf-out');
const elfOut = eo >= 0 ? args[eo + 1] : null;
const stage1 = new Uint8Array(readFileSync(process.env.STAGE1 ?? join(root, 'vendor/stage1.elf')));
const wasm = new Uint8Array(readFileSync(process.env.YANTRA_WASM ?? join(root, 'vendor/yantra_wasm.wasm')));
const r = await compileAndRun(stage1, wasm, readFileSync(args[0], 'utf8'), pins);
if (r.error) {
  console.log(JSON.stringify(r));
  process.exit(r.error === 'PinMismatch' ? 4 : r.error === 'CellShapeRefused' ? 3 : 2);
}
if (elfOut) writeFileSync(elfOut, r.elf);
const { elf, files, ...row } = r;
// files the program wrote, by name, length and sha256 (absent when none, so file-free rows are unchanged)
if (files.length) row.files = await Promise.all(files.map(async (f) => ({ name: f.name, length: f.bytes.length, sha256: await sha256(f.bytes) })));
console.log(JSON.stringify(row));
