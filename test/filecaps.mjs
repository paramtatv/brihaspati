// SPDX-License-Identifier: AGPL-3.0-only
// A program's write over the per-file cap is refused by the engine and leaves no file; a write under it is kept.
// test/image-cells/png_and_svg.t1 writes a 121-octet png (खपत्रम्) and a 259-octet svg (कपत्रम्); the per-file cap is 200.
// CONTROL: the same cell with the default caps keeps both files.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compileAndRun } from '../kernel/core.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(readFileSync(join(root, 'kernel/pins.json'), 'utf8'));
const stage1 = new Uint8Array(readFileSync(join(root, 'vendor/stage1.elf')));
const wasm = new Uint8Array(readFileSync(join(root, 'vendor/yantra_wasm.wasm')));
const src = readFileSync(join(root, 'test/image-cells/png_and_svg.t1'), 'utf8');
let bad = 0;
const check = (ok, what) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) bad++; };
const names = (r) => r.files.map((f) => `${f.name}:${f.bytes.length}`).join();
const capped = await compileAndRun(stage1, wasm, src, pins, { fileCaps: { total: 1 << 20, file: 200 } });
check(!capped.error && names(capped) === 'खपत्रम्:121', `per-file cap 200: only the 121-octet png is kept (${names(capped)})`);
const control = await compileAndRun(stage1, wasm, src, pins);
check(!control.error && names(control) === 'कपत्रम्:259,खपत्रम्:121', `control, default caps: both files are kept (${names(control)})`);
process.exit(bad ? 1 : 0);
