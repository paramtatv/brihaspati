// SPDX-License-Identifier: AGPL-3.0-only
// For every cell: run NATIVE (kernel/native.sh) and WASM (kernel/cell.mjs) and require
// native == expected == wasm on every field except wall time. Exits non-zero on any disagreement.
// expected.jsonl must be native-made (provenance fields are checked against kernel/pins.json).
// A NEGATIVE CONTROL runs first: one field of one expected row is flipped in memory and the
// comparison MUST report a difference, or the comparison itself is broken and the run fails.
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(readFileSync(join(root, 'kernel/pins.json'), 'utf8'));
const FIELDS = ['error', 'elf_sha256', 'status', 'output_hex', 'steps_compile', 'steps_run', 'ram_run', 'high_water_run'];
const differs = (a, b) => FIELDS.filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null));
const expected = Object.fromEntries(readFileSync(join(root, 'cells/expected.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => { const j = JSON.parse(l); return [j.cell, j]; }));

const sample = Object.values(expected).find((r) => r.elf_sha256);
const flipped = { ...sample, steps_run: sample.steps_run + 1 };
if (differs(sample, flipped).length !== 1 || differs(sample, sample).length !== 0) {
  console.log('FAIL negative control: the comparison did not see a flipped field'); process.exit(1);
}
console.log('ok   negative control: a flipped steps_run is reported as a difference');

const run = (cmd, args) => {
  try { return JSON.parse(execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26 })); }
  catch (err) { // refusals exit non-zero but still print their JSON
    try { return JSON.parse(err.stdout); } catch { return { error: 'driver: ' + String(err.message).split('\n')[0] }; }
  }
};
let bad = 0, n = 0, tn = 0, tw = 0;
for (const f of readdirSync(join(root, 'cells')).filter((x) => x.endsWith('.t1')).sort()) {
  n++;
  const want = expected[f], path = join(root, 'cells', f);
  if (!want) { console.log(`FAIL ${f}: no expected row`); bad++; continue; }
  const prov = want.engine !== 'native' || want.yantra_run_sha256 !== pins.yantra_run_sha256 || want.stage1_sha256 !== pins.stage1_sha256;
  const nat = run('sh', [join(root, 'kernel/native.sh'), path]);
  const wasm = run('node', [join(root, 'kernel/cell.mjs'), path]);
  if (nat.wall_compile_s) tn += nat.wall_compile_s;
  if (wasm.wall_compile_s) tw += wasm.wall_compile_s;
  const d1 = differs(nat, want), d2 = differs(want, wasm);
  const ok = !prov && !d1.length && !d2.length;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${f} ${want.error ?? `status=${want.status} steps=${want.steps_compile}+${want.steps_run} ram=${want.ram_run}`}` +
    (prov ? ' [expected row is not native-made under the pinned binaries]' : '') +
    (d1.length ? ` [native!=expected: ${d1}]` : '') + (d2.length ? ` [expected!=wasm: ${d2}]` : ''));
  if (!ok) bad++;
}
console.log(`${n - bad}/${n} cells: native == expected == wasm; compile wall native ${tn.toFixed(1)}s, wasm ${tw.toFixed(1)}s`);
process.exit(bad ? 1 : 0);
