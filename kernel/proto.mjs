// SPDX-License-Identifier: AGPL-3.0-only
// BR-11: the page <-> worker protocol for a live notebook session (multi-message; the worker stays alive between messages).
//   page -> worker   {t:'load', cells:[{id,src,kind}]}  {t:'run', rid, id, src}  {t:'runall', rid, cells}  {t:'poll', rid}  {t:'stop', rid}
//   worker -> page   {t:'ready'}  {t:'progress', rid, id, steps, partialHex}  {t:'done', rid, id, row, needs, defines}
//                    {t:'status', rid, state:'idle'|'running', id, steps}  {t:'error', rid, name, why}
// Stop = Session.interrupt(): honoured at the next slice boundary; the worker yields to its event loop after every slice so
// the 'stop' and 'poll' messages are delivered mid-cell. State is kept (cell effects restored via snapshot when the engine has it).
import { Session, INTERRUPTED_NAME } from './session.mjs';

const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const nextTick = () => new Promise((r) => (typeof setImmediate === 'function' ? setImmediate(r) : setTimeout(r, 0)));

// ---- worker side. opts: api (machine interface), compileFragment, slice, post(msg). Returns handle(msg). ----
export function serveWorker({ api, compileFragment, slice, post, tick = nextTick }) {
  let session = null, lastCompile = null, running = null, queue = Promise.resolve(), stopRid = 0;   // stopRid: latch, the newest request a Stop was sent for
  const hook = async (a) => { const r = await compileFragment(a); lastCompile = r; return r; };
  const ensure = () => session ??= new Session({
    api, slice, compileFragment: hook,
    onSlice: async ({ cell, partial, steps }) => { running.steps = steps; post({ t: 'progress', rid: running.rid, id: cell, steps, partialHex: hexOf(partial) }); await tick(); },
  });
  const one = async (rid, id) => {
    running = { rid, id, steps: 0 }; lastCompile = null;
    // a Stop that arrived before this cell started (open/compile, or between cells) must not be lost: Session.runCell clears its own flag
    const r = stopRid === rid ? { row: { interrupted: true, refusal: INTERRUPTED_NAME, stdout: '', stdout_hex: '', halt: '', status: null, steps: 0, symbols: [] }, mismatch: null } : await session.runCell(id);
    post({ t: 'done', rid, id, row: r.row, mismatch: r.mismatch, needs: lastCompile?.needs ?? [], defines: lastCompile?.defines ?? [] });
    running = null; return r.row;
  };
  const sync = (cells) => { const s = ensure(); for (const c of cells) { try { s.cell(c.id).src = c.src; } catch { s.addCell(c.id, c.src, c.kind ?? 'code'); } } return s; };
  const work = async (m) => {
    try {
      if (m.t === 'load') { sync(m.cells); post({ t: 'ready' }); }
      else if (m.t === 'run') { sync([{ id: m.id, src: m.src }]); await session.open(); await one(m.rid, m.id); }
      else if (m.t === 'runall') {
        const s = sync(m.cells); await s.open(); s.api.machine_reset(s.machine); s.symbols.clear(); s.dirty = false;   // Run all = restart
        for (const c of m.cells) if ((c.kind ?? 'code') === 'code') { if (stopRid === m.rid) break; const row = await one(m.rid, c.id); if (row.interrupted) break; }
        post({ t: 'done', rid: m.rid, id: null, all: true });
      }
    } catch (e) { running = null; post({ t: 'error', rid: m.rid, name: e.name ?? 'Error', why: String(e.why ?? e.message ?? e) }); }
  };
  // stop and poll are answered immediately (they may arrive while a cell is between slices); the rest are serialised.
  return (m) => {
    if (m.t === 'stop') { if (m.rid) stopRid = Math.max(stopRid, m.rid); session?.interrupt(); return; }
    if (m.t === 'poll') { post({ t: 'status', rid: m.rid, state: running ? 'running' : 'idle', id: running?.id ?? null, steps: running?.steps ?? 0 }); return; }
    queue = queue.then(() => work(m));
  };
}

// ---- page side: the controller the UI binds to. spawn() -> {postMessage, onmessage (settable), terminate}. ----
export class NotebookController {
  constructor({ spawn, onChange = () => {} }) {
    this.spawn = spawn; this.onChange = onChange;
    this.cells = new Map();   // id -> {id, src, status, steps, partial, row, ranAt, deps:{owner:ownerRanAt}, interrupted}
    this.seq = 0; this.rid = 0; this.pending = new Map(); this.active = null; this.ready = null;
    this.w = null;
  }
  _start() {
    if (this.w) return;
    this.w = this.spawn();
    this.ready = new Promise((r) => { this._ready = r; });
    const w = this.w;
    w.onmessage = (ev) => this._on(ev.data ?? ev);
    w.onerror = (ev) => { if (this.w === w) this._died(ev?.message ?? ev?.why ?? 'worker error'); };
    this.w.postMessage({ t: 'load', cells: [...this.cells.values()].map((c) => ({ id: c.id, src: c.src, kind: 'code' })) });
  }
  setCell(id, src) { const c = this.cells.get(id) ?? { id, status: 'idle', steps: 0, partial: '', row: null, ranAt: 0, deps: {} }; c.src = src; this.cells.set(id, c); return c; }
  // stale: ran before, and a cell it depends on has been (re)run successfully since.
  isStale(id) { const c = this.cells.get(id); if (!c?.ranAt) return false; return Object.entries(c.deps).some(([o, at]) => (this.cells.get(o)?.ranAt ?? 0) > at); }
  stale() { return [...this.cells.keys()].filter((i) => this.isStale(i)); }
  busy() { return this.active !== null; }
  _on(m) {
    if (m.t === 'ready') { this._ready(); return; }
    const c = m.id != null ? this.cells.get(m.id) : null;
    if (m.t === 'progress' && c) { c.status = 'running'; c.steps = m.steps; c.partial = m.partialHex; }
    else if (m.t === 'done') {
      if (c) {
        c.row = m.row; c.steps = m.row.steps ?? c.steps; c.interrupted = !!m.row.interrupted; c.partial = '';
        c.status = c.interrupted ? 'stopped' : m.row.refusal ? 'refused' : 'done';
        if (!c.interrupted && !m.row.refusal) {
          c.ranAt = ++this.seq;
          c.deps = {}; for (const n of m.needs ?? []) { const o = this.owners?.get(n); if (o !== undefined && o !== c.id) c.deps[o] = this.cells.get(o)?.ranAt ?? 0; }
          for (const n of m.defines ?? []) this.owners.set(n, c.id);
        }
      }
      const p = this.pending.get(m.rid);
      if (p && (m.all || !p.all)) { this.pending.delete(m.rid); if (this.active === m.rid) this.active = null; p.resolve(m); }
    } else if (m.t === 'status') { this.pending.get(m.rid)?.resolve(m); this.pending.delete(m.rid); }
    else if (m.t === 'error') {
      const p = this.pending.get(m.rid); this.pending.delete(m.rid); if (this.active === m.rid) this.active = null;
      for (const x of this.cells.values()) if (x.status === 'running') x.status = 'refused';
      p?.resolve(m);
    }
    this.onChange(this);
  }
  owners = new Map();   // symbol -> owning cell id (mirror of the session table, for stale tracking)
  _send(msg, all = false) {
    this._start(); const rid = ++this.rid;
    return new Promise((resolve) => { this.pending.set(rid, { resolve, all }); { const w = this.w; this.ready.then(() => { if (w === this.w) w.postMessage({ ...msg, rid }); }); } });
  }
  async run(id) {
    if (this.busy()) return { t: 'error', name: 'Busy', why: 'a run is in progress' };
    const c = this.cells.get(id); c.status = 'running'; c.steps = 0; c.partial = '';
    const p = this._send({ t: 'run', id, src: c.src }); this.active = this.rid; this.onChange(this); return p;
  }
  async runAll() {   // restart: clean machine on the worker, every dependency record dropped here
    if (this.busy()) return { t: 'error', name: 'Busy', why: 'a run is in progress' };
    this.owners.clear();
    for (const c of this.cells.values()) { c.deps = {}; c.ranAt = 0; c.status = 'idle'; c.row = null; }
    const p = this._send({ t: 'runall', cells: [...this.cells.values()].map((c) => ({ id: c.id, src: c.src, kind: 'code' })) }, true); this.active = this.rid; this.onChange(this); return p;
  }
  stop() { if (this.w && this.busy()) this.w.postMessage({ t: 'stop', rid: this.active }); }   // state is kept; the partial output stays shown
  poll() { return this._send({ t: 'poll' }); }
  // the worker is gone (crash, terminate): its session and machine with it. Fail what was waiting, forget the symbol table;
  // the next run starts a fresh worker (_start re-sends 'load').
  _died(why) {
    const pend = [...this.pending]; this.pending.clear(); this.active = null; this.w = null; this.owners.clear();
    for (const x of this.cells.values()) { if (x.status === 'running') x.status = 'refused'; x.deps = {}; }
    for (const [rid, p] of pend) p.resolve({ t: 'error', rid, name: 'WorkerLost', why });
    this.onChange(this);
  }
  close() { const w = this.w; if (!w) return; w.terminate(); this._died('closed'); }
}
