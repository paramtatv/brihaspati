// A cell that never finishes must come back as the named error StepLimitExceeded, not as "halt:5".
// The cell is cells/loop_sum.t1 with its counter increment removed; the budget is lowered to 2,000,000 steps for speed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compileAndRun } from '../kernel/core.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(readFileSync(join(root, 'kernel/pins.json'), 'utf8'));
const src = readFileSync(join(root, 'cells/loop_sum.t1'), 'utf8').split('\n').filter((l) => !l.includes('क्रमः भवति आरभ्य क्रमः योगः १ समाप्तम्')).join('\n');
const r = await compileAndRun(new Uint8Array(readFileSync(join(root, 'vendor/stage1.elf'))), new Uint8Array(readFileSync(join(root, 'vendor/yantra_wasm.wasm'))), src, pins, { runSteps: 2_000_000 });
const ok = r.error === 'StepLimitExceeded' && r.status === undefined && /2000000/.test(r.why);
console.log(ok ? 'ok   step limit is a named error:' : 'FAIL step limit:', r.error, r.why);
process.exit(ok ? 0 : 1);
