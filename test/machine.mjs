// SPDX-License-Identifier: AGPL-3.0-only
// The machine adapter (kernel/machine.mjs) over yantra-wasm.
//  1. the contract is complete; 2. NEGATIVE CONTROLS: every call the engine cannot do refuses by name (no fake success);
//  3. the default path through the interface equals compileAndRun field for field (all fields but wall time) for every cell
//     and equals cells/expected.jsonl (native-made) on the agree.mjs fields.  usage: node test/machine.mjs [--quick]
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compileAndRun } from '../kernel/core.mjs';
import { yantraWasmMachineApi, compileAndRunViaMachine, MachineRefusal, MACHINE_CALLS, assertImplements, elfInfo } from '../kernel/machine.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(readFileSync(join(root, 'kernel/pins.json'), 'utf8'));
const stage1 = new Uint8Array(readFileSync(join(root, 'vendor/stage1.elf')));
const wasm = new Uint8Array(readFileSync(join(root, 'vendor/yantra_wasm.wasm')));
const quick = process.argv.includes('--quick');
let bad = 0;
const check = (ok, what) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) bad++; };
const refuses = (fn, name, call) => { try { fn(); return false; } catch (e) { return e instanceof MachineRefusal && e.name === name && (!call || e.call === call); } };

const api = yantraWasmMachineApi(wasm);
check(MACHINE_CALLS.every((k) => typeof api[k] === 'function'), `contract: all ${MACHINE_CALLS.length} calls present`);
check(refuses(() => assertImplements({}), 'ContractIncomplete'), 'control: an incomplete implementation is refused');
const caps = api.capabilities();
check(Object.values(caps).every((v) => v === false), 'capabilities: this engine claims none of resume/snapshot/yield/link/load_at/multi_image/host files');

// a tiny valid ELF to exercise load/state without compiling: use a compiled cell's image from the stage1 itself
const m = await api.machine_new(20 << 20);
const info = api.load(m, stage1);
check(info.entry > 0 && info.extent > 0, `load returns entry 0x${info.entry.toString(16)} and extent ${info.extent}`);
check(refuses(() => api.load(m, stage1), 'Unsupported', 'load'), 'control: a second image is refused by name');
api.machine_reset(m);
check(refuses(() => api.load(m, stage1, 0x1000), 'Unsupported', 'load'), 'control: load at an address is refused by name');
check(refuses(() => api.load(m, new Uint8Array(100)), 'BadImage', 'load'), 'control: a non-ELF image is refused');
check(refuses(() => api.run(m, 10), 'MachineState', 'run'), 'control: run with no image refuses');
check(refuses(() => api.snapshot(m), 'Unsupported', 'snapshot'), 'control: snapshot (M5) refuses by name');
check(refuses(() => api.restore(m, {}), 'Unsupported', 'restore'), 'control: restore (M5) refuses by name');
check(refuses(() => api.link(m, {}, new Map()), 'Unsupported', 'link'), 'control: fragment link refuses by name');
check(refuses(() => api.files_write(m, 'a', new Uint8Array(1)), 'Unsupported', 'files_write'), 'control: host file write refuses by name');
check(refuses(() => api.files_delete(m, 'a'), 'Unsupported', 'files_delete'), 'control: host file delete refuses by name');
check(api.steps(m) === null && api.water(m) === null, 'steps/water are null before any run');
api.load(m, stage1);
api.run(m, 1000);   // the compiler with no input: stops at the step budget (or earlier); either way the machine is now spent
check(api.run && refuses(() => api.run(m, 1000), 'Unsupported', 'run'), 'control: run after a run (M4 resume) refuses by name, not a silent re-run');
check(api.steps(m) !== null && api.steps(m) <= 1000, `steps(m) after a 1000-step budget: ${api.steps(m)}`);
check(api.out_take(m) instanceof Uint8Array && api.out_take(m).length === 0, 'out_take clears: the second take is empty');
api.machine_drop(m);
check(refuses(() => api.run(m, 1), 'MachineState', 'run'), 'control: a dropped machine refuses');
const big = await api.machine_new(5 * 2 ** 30);
api.load(big, stage1);
try { api.run(big, 10); check(false, 'AllocationRefused on > 4096 MiB'); } catch (e) { check(e.name === 'AllocationRefused' && e.mib === 5120, `M10: >4 GiB RAM is AllocationRefused carrying mib=${e.mib}`); }

// the default path through the interface
const expected = Object.fromEntries(readFileSync(join(root, 'cells/expected.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { const j = JSON.parse(l); return [j.cell, j]; }));
const FIELDS = ['error', 'elf_sha256', 'status', 'output_hex', 'steps_compile', 'steps_run', 'ram_run', 'high_water_run'];
const strip = (r) => { const { wall_compile_s, elf, files, ...x } = r; return { ...x, files: (files ?? []).map((f) => `${f.name}:${f.bytes.length}`) }; };
const filesHex = (r) => JSON.stringify((r.files ?? []).map((f) => [f.name, Array.from(f.bytes)]));
let cells = readdirSync(join(root, 'cells')).filter((x) => x.endsWith('.t1')).sort();
if (quick) cells = cells.filter((f) => ['print_x.t1', 'loop_sum.t1', 'division_by_zero_refusal.t1', 'entry_not_fixed_refused.t1'].includes(f));
const extra = [join('test/image-cells', 'png_and_svg.t1')];
for (const rel of [...cells.map((f) => join('cells', f)), ...extra]) {
  const src = readFileSync(join(root, rel), 'utf8');
  const a = await compileAndRun(stage1, wasm, src, pins);
  const b = await compileAndRunViaMachine(api, stage1, src, pins);
  const same = JSON.stringify(strip(a)) === JSON.stringify(strip(b)) && filesHex(a) === filesHex(b);
  const e = expected[rel.split('/').pop()];
  const dExp = e ? FIELDS.filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(e[k] ?? null)) : [];
  check(same && !dExp.length, `${rel}: machine route == compileAndRun${e ? ` == expected (${e.error ?? `steps ${e.steps_compile}+${e.steps_run}`})` : ''}${dExp.length ? ' [expected differs: ' + dExp + ']' : ''}`);
}
// negative control of the comparison itself
{
  const src = readFileSync(join(root, 'cells/print_x.t1'), 'utf8');
  const a = await compileAndRun(stage1, wasm, src, pins), b = await compileAndRunViaMachine(api, stage1, src, pins);
  check(JSON.stringify(strip(a)) !== JSON.stringify(strip({ ...b, steps_run: b.steps_run + 1 })), 'control: a flipped steps_run is seen by the comparison');
}
// StepLimit through the interface, same shape as test/steplimit.mjs
{
  const src = readFileSync(join(root, 'cells/loop_sum.t1'), 'utf8').split('\n').filter((l) => !l.includes('क्रमः भवति आरभ्य क्रमः योगः १ समाप्तम्')).join('\n');
  const r = await compileAndRunViaMachine(api, stage1, src, pins, { runSteps: 2_000_000 });
  check(r.error === 'StepLimitExceeded' && /2000000/.test(r.why), `StepLimit via interface: ${r.error}`);
}
process.exit(bad ? 1 : 0);
