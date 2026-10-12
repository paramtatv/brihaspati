// SPDX-License-Identifier: AGPL-3.0-only
// The notebook session model (kernel/session.mjs) against a SCRIPTED fake machine (the .t1 interpreter does not exist yet),
// plus the real yantra-wasm adapter, which must refuse a fragment cell by name (no fake success).
// Rulings under test: Q1 named symbols, Q3 replace + Run all restart, Q6 compare rule, Q7 interrupted partial output.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Session, refuseFragmentCompiler } from '../kernel/session.mjs';
import { yantraWasmMachineApi, MachineRefusal, MACHINE_CALLS } from '../kernel/machine.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let bad = 0;
const check = (ok, what) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) bad++; };
const te = new TextEncoder();

// fake engine: a fragment is {out: string, yields: n (slices before it ends), steps, halt}. Counts resets/drops.
function fakeApi({ snapshots = false } = {}) {
  const log = { resets: 0, restores: 0, linked: [] };
  const api = {
    log,
    async machine_new() { return { out: new Uint8Array(0), cur: null, left: 0 }; },
    machine_reset(m) { log.resets++; m.cur = null; m.out = new Uint8Array(0); },
    machine_drop() {},
    load() { throw new Error('unused'); },
    link(m, frag) { log.linked.push(frag.id); m.cur = frag; m.left = frag.yields ?? 0; },
    run(m, budget) {
      const f = m.cur;
      if (m.left > 0) { m.left--; m.out = te.encode(f.chunk ?? ''); return { kind: 'yield', steps: 10, halt: '' }; }
      m.out = te.encode(f.tail ?? f.out ?? '');
      return { kind: 'exit', status: f.status ?? 0, steps: f.steps ?? 100, halt: f.halt ?? 'exit status 0' };
    },
    snapshot() { return { s: 1 }; }, restore() { log.restores++; },
    out_take(m) { const o = m.out; m.out = new Uint8Array(0); return o; },
    input_put() {}, files_list() { return []; }, files_read() {}, files_write() {}, files_delete() {},
    steps() { return 0; }, water() { return 0; },
    capabilities() { return { snapshot: snapshots, yield: true }; },
  };
  return api;
}
// fake fragment compiler: src is "id|defines|needs|out|steps|yields|chunk"
const compile = ({ src }) => {
  const [id, d, n, out, steps, yields, chunk] = src.split('|');
  return { fragment: { id, out, tail: out, steps: Number(steps || 100), yields: Number(yields || 0), chunk }, defines: d ? d.split(',') : [], needs: n ? n.split(',') : [] };
};
const mk = async (opts = {}, apiOpts) => {
  const api = fakeApi(apiOpts), s = new Session({ api, compileFragment: compile, ...opts });
  await s.open(); return { api, s };
};

// Q1/Q3 replace: cell b re-run with new definitions drops its old symbols
{
  const { s } = await mk();
  s.addCell('a', 'a|x||1|100').addCell('b', 'b|y,z||2|100');
  await s.runCell('a'); await s.runCell('b');
  check(s.symbolsOf('a').join() === 'x' && s.symbolsOf('b').join() === 'y,z', 'symbols are owned per cell');
  s.cell('b').src = 'b|y||2|100';
  await s.runCell('b');
  check(s.symbolsOf('b').join() === 'y' && !s.symbols.has('z'), 'replace-on-rerun: the old symbol z is gone, y stays');
  // CONTROL: without the replace rule z would survive; assert the table is exactly what the last run defined
  check([...s.symbols.keys()].sort().join() === 'x,y', 'control: table is exactly {x, y}');
  // naming: a cell cannot take another cell's symbol; a missing need is refused by name; neither fakes success
  s.addCell('c', 'c|x||3|100'); const rc = await s.runCell('c');
  check(rc.row.refusal === 'SymbolOwnedByOtherCell' && s.symbols.get('x') === 'a', 'a symbol owned by another cell is refused by name; owner unchanged');
  s.addCell('d', 'd||nope|4|100'); const rd = await s.runCell('d');
  check(rd.row.refusal === 'UndefinedSymbol', 'a need with no definition is refused by name (UndefinedSymbol)');
  s.addCell('e', 'e||x|5|100'); const re = await s.runCell('e');
  check(!re.row.refusal, 'a need satisfied by an earlier cell runs (named symbol)');
}
// failed re-run keeps the old symbols (replace happens only on a successful link)
{
  const { s } = await mk();
  s.addCell('a', 'a|x||1|100'); await s.runCell('a');
  s.cell('a').src = 'a|x|ghost|1|100'; const r = await s.runCell('a');
  check(r.row.refusal === 'UndefinedSymbol' && s.symbolsOf('a').join() === 'x', 'failed re-run: old symbols kept');
}
// Run all = clean restart
{
  const { api, s } = await mk();
  s.addCell('a', 'a|x||1|100').addCell('b', 'b|y|x|2|100').addCell('n', 'note', 'note');
  await s.runCell('a'); await s.runCell('b');
  s.cell('a').src = 'a|w||1|100';             // x vanishes from a; b needs x
  const res = await s.runAll();
  check(api.log.resets === 1 && res.length === 2, 'Run all: one machine_reset, notes skipped');
  check(res[1].row.refusal === 'UndefinedSymbol' && !s.symbols.has('x') && s.symbols.has('w'), 'Run all restarts from a clean table: stale x is not visible to b');
  const { api: api2, s: s2 } = await mk();
  s2.addCell('a', 'a|x||1|100'); await s2.runCell('a'); await s2.runCell('a');
  check(api2.log.resets === 0, 'control: re-running one cell does NOT reset the machine');
}
// Q6: steps mismatch ignored except Run all; stdout/halt mismatch always
{
  const { s } = await mk();
  s.addCell('a', 'a|x||hi|100');
  const first = await s.runCell('a'); check(first.mismatch === null, 'first run: nothing saved before, no comparison');
  s.cell('a').src = 'a|x||hi|999';
  const r1 = await s.runCell('a');
  check(r1.mismatch.length === 0, 'Q6: steps 100 -> 999 on a single run is NOT a mismatch');
  s.cell('a').src = 'a|x||hi|555';
  const r2 = (await s.runAll())[0];
  check(r2.mismatch.join() === 'steps', 'Q6 control: the same drift on Run all IS a mismatch (steps only)');
  s.cell('a').src = 'a|x||bye|555';
  const r3 = await s.runCell('a');
  check(r3.mismatch.join() === 'stdout', 'Q6: changed stdout is a mismatch even on a single run');
  s.cell('a').saved = { ...s.cell('a').saved, halt: 'exit status 7' };
  const r4 = await s.runCell('a');
  check(r4.mismatch.includes('halt'), 'Q6: changed halt line is a mismatch even on a single run');
}
// Q7: interrupt keeps and saves partial stdout, marked interrupted
for (const snapshots of [false, true]) {
  let slices = 0;
  const { api, s } = await mk({ onSlice: () => { if (++slices === 1) s.interrupt(); } }, { snapshots });
  s.addCell('a', 'a|x||final|100|5|part;');
  const r = await s.runCell('a');
  check(r.row.interrupted === true && r.row.stdout === 'part;' && r.row.refusal === 'Interrupted' && r.row.stop === 'yield', `Q7: interrupted cell: partial stdout "${r.row.stdout}" saved with the mark (snapshot=${snapshots})`);
  check(s.cell('a').saved.interrupted === true && s.symbols.size === 0, 'Q7: the saved row carries the mark; the cell registered no symbols');
  check(snapshots ? api.log.restores === 1 && !s.dirty : api.log.restores === 0 && s.dirty, `Q7: effects ${snapshots ? 'discarded via restore' : 'cannot be discarded: session flagged dirty (Run all advised)'}`);
  // control: an uninterrupted run of the same cell finishes with the tail and no mark
  const { s: s2 } = await mk(); s2.addCell('a', 'a|x||final|100|5|part;');
  const ok = await s2.runCell('a');
  check(!ok.row.interrupted && ok.row.stdout === 'part;part;part;part;part;final', 'control: uninterrupted run is complete and unmarked');
  // an interrupted saved row vs a complete rerun is a mismatch (stdout and interrupted)
  if (!snapshots) { const c = s.compare(s.cell('a').saved, ok.row); check(c.includes('interrupted') && c.includes('stdout'), 'interrupted saved vs complete rerun: mismatch on stdout + interrupted'); }
}
// the real adapter: contract complete; a fragment cell is REFUSED by name, nothing runs, nothing registered
{
  const api = yantraWasmMachineApi(new Uint8Array(readFileSync(join(root, 'vendor/yantra_wasm.wasm'))));
  check(MACHINE_CALLS.every((k) => typeof api[k] === 'function'), 'adapter implements the contract');
  const s = new Session({ api }); s.addCell('a', 'any fragment');
  const r = await s.runCell('a');
  check(r.row.refusal === 'FragmentCompilerUnavailable' && s.symbols.size === 0, 'default hook refuses by name (FragmentCompilerUnavailable); no fake success');
  const s2 = new Session({ api, compileFragment: (x) => ({ ...compile({ src: 'a|x||1|1' }) }) }); s2.addCell('a', 'a');
  const r2 = await s2.runCell('a');
  check(r2.row.refusal === 'Unsupported' && r2.row.call === 'link' && s2.symbols.size === 0, 'with a fragment compiler but today\'s engine: link refuses by name (Unsupported/link); no symbols registered');
  let threw = false; try { refuseFragmentCompiler(); } catch (e) { threw = e instanceof MachineRefusal; }
  check(threw, 'refuseFragmentCompiler throws a MachineRefusal');
}
process.exit(bad ? 1 : 0);
