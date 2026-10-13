// SPDX-License-Identifier: AGPL-3.0-only
// बृहस्पति L28: the notebook SESSION model over the machine interface (kernel/machine.mjs).
// Owner rulings of 2026-10-12 (agent-handovers/T1-INTERPRETER.md "Owner rulings on Step 0"):
//  Q1 a cell reaches an earlier cell's value by NAMED SYMBOL.      Q2 a cell is a FRAGMENT linked into the live image.
//  Q3 re-run/edit of cell N REPLACES its symbols; "Run all" = restart from a clean machine.
//  Q6 saved outputs always compare stdout + halt line; steps compare only on Run all.
//  Q7 an interrupted cell's partial stdout is shown and saved, marked interrupted (refusal name: not yet assigned).
// Environment-neutral; no I/O. The fragment compiler (a new compiler mode, not built yet) is a pluggable hook.
import { MachineRefusal, assertImplements } from './machine.mjs';

// The default fragment compiler: refuses by name. Hook shape:
//   compileFragment({ cell, src, symbols: Map<name, cellId> }) -> { fragment, defines: [name], needs: [name] }
export const refuseFragmentCompiler = () => {
  throw new MachineRefusal('FragmentCompilerUnavailable', 'compileFragment', 'the fragment compiler mode is not built yet (Q2); no cell can run in a live session');
};
// Pending name for an interrupted cell (the owner assigns the code); the row also carries interrupted:true.
export const INTERRUPTED_NAME = 'Interrupted';
export const DEFAULT_SLICE = 50_000_000;

const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const cat = (a, b) => { const r = new Uint8Array(a.length + b.length); r.set(a, 0); r.set(b, a.length); return r; };

export class Session {
  // opts: api (machine interface), ram, compileFragment hook, slice (steps per run call), budget (steps per cell)
  constructor({ api, ram = 20 << 20, compileFragment = refuseFragmentCompiler, slice = DEFAULT_SLICE, budget = 4_000_000_000, files, onSlice = null } = {}) {
    this.onSlice = onSlice;     // called after each Yield (the page's chance to repaint and to call interrupt())
    this.api = assertImplements(api);
    this.ram = ram; this.compileFragment = compileFragment; this.slice = slice; this.budget = budget; this.files = files;
    this.cells = [];             // [{id, kind: 'code'|'note', src, saved: row|null}]
    this.symbols = new Map();    // name -> owning cell id
    this.machine = null;
    this.dirty = false;          // an interrupted cell without snapshot support left unknown state in the machine
    this._stop = false;
  }
  async open() { if (!this.machine) this.machine = await this.api.machine_new(this.ram, this.files ? { files: this.files } : {}); return this; }
  close() { if (this.machine) this.api.machine_drop(this.machine); this.machine = null; }
  addCell(id, src, kind = 'code', saved = null) { this.cells.push({ id, kind, src, saved }); return this; }
  cell(id) { const c = this.cells.find((x) => x.id === id); if (!c) throw new MachineRefusal('NoSuchCell', 'cell', `no cell ${id}`); return c; }
  symbolsOf(id) { return [...this.symbols].filter(([, o]) => o === id).map(([n]) => n).sort(); }
  interrupt() { this._stop = true; }   // takes effect at the next slice boundary

  // Q3: Run all = a clean machine and an empty symbol table, then every code cell in order. Steps are compared here.
  async runAll() {
    await this.open();
    this.api.machine_reset(this.machine);
    this.symbols.clear(); this.dirty = false;
    const results = [];
    for (const c of this.cells) if (c.kind === 'code') {
      const r = await this.runCell(c.id, { runAll: true });
      results.push(r);
      if (r.row.interrupted) break;      // a stopped Run all stops
    }
    return results;
  }

  // Run one cell. Returns {id, row, mismatch}; mismatch = null (nothing saved before) or [] / [field...].
  // Named refusals do not throw: they become the row (refusal, why). The saved row is replaced either way.
  async runCell(id, { runAll = false } = {}) {
    await this.open();
    const c = this.cell(id);
    const before = c.saved;
    this._stop = false;
    let row;
    try { row = await this._exec(c); }
    catch (err) {
      if (!(err instanceof MachineRefusal)) throw err;
      row = { refusal: err.name, call: err.call, why: err.why, stdout_hex: '', stdout: '', halt: '', status: null, steps: null, interrupted: false };
    }
    c.saved = row;
    return { id, row, mismatch: before ? this.compare(before, row, { runAll }) : null };
  }

  async _exec(c) {
    const { api } = this, m = this.machine;
    // Compile first (a refusal leaves the old symbols of this cell in place: replace happens only on success).
    const compiled = await this.compileFragment({ cell: c.id, src: c.src, symbols: new Map(this.symbols) });
    const own = (n) => this.symbols.get(n) === c.id;
    for (const n of compiled.defines) {
      const o = this.symbols.get(n);
      if (o !== undefined && o !== c.id) throw new MachineRefusal('SymbolOwnedByOtherCell', 'compileFragment', `${n} is defined by cell ${o}`, { symbol: n, owner: o });
    }
    for (const n of compiled.needs ?? []) {
      if (!this.symbols.has(n) || (own(n) && !compiled.defines.includes(n))) throw new MachineRefusal('UndefinedSymbol', 'compileFragment', `${n} is not defined by any earlier cell`, { symbol: n });
    }
    // Q3 replace: this cell's previous symbols go, the new ones are installed (after a successful link).
    const snap = api.capabilities().snapshot ? api.snapshot(m) : null;
    api.link(m, compiled.fragment, new Map(this.symbols));
    let out = new Uint8Array(0), stop, interrupted = false, steps = 0;
    for (;;) {
      stop = api.run(m, Math.min(this.slice, this.budget - steps));
      out = cat(out, api.out_take(m));
      steps += stop.steps ?? 0;
      if (stop.kind !== 'yield') break;
      if (this.onSlice) await this.onSlice({ cell: c.id, partial: out, steps });
      if (this._stop) { interrupted = true; break; }
    }
    if (interrupted) {
      // Q7: partial stdout kept and marked. The cell's effects are discarded when the engine can snapshot; else flagged.
      if (snap) api.restore(m, snap); else this.dirty = true;
    } else {
      for (const [n, o] of [...this.symbols]) if (o === c.id) this.symbols.delete(n);
      for (const n of compiled.defines) this.symbols.set(n, c.id);
    }
    const stdout = new TextDecoder().decode(out);
    return {
      stdout, stdout_hex: hexOf(out), halt: stop.halt ?? '', status: stop.kind === 'exit' ? stop.status : null,
      stop: interrupted ? 'yield' : stop.kind, steps, interrupted,
      ...(interrupted ? { refusal: INTERRUPTED_NAME } : {}),
      symbols: interrupted ? [] : this.symbolsOf(c.id),
    };
  }

  // Q6: stdout + halt line always (plus the interrupted mark); steps only on Run all.
  compare(saved, now, { runAll = false } = {}) {
    const f = [];
    if (saved.stdout_hex !== now.stdout_hex) f.push('stdout');
    if (saved.halt !== now.halt) f.push('halt');
    if (!!saved.interrupted !== !!now.interrupted) f.push('interrupted');
    if ((saved.refusal ?? null) !== (now.refusal ?? null)) f.push('refusal');
    if (runAll && saved.steps !== now.steps) f.push('steps');
    return f;
  }
}
