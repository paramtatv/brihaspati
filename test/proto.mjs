// SPDX-License-Identifier: AGPL-3.0-only
// BR-11 headless test (node only): NotebookController <-> serveWorker over an async loopback, mock machine. node test/proto.mjs
import { serveWorker, NotebookController, nextTick } from '../kernel/proto.mjs';
import { mockApi, mockCompile } from './mock-machine.mjs';
import { scenarios } from './br11-scenarios.mjs';
let bad = 0;
const check = (ok, what) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) bad++; };
// loopback "Worker": every message crosses a macrotask boundary both ways, like postMessage
function loopback(handler) {
  const w = { onmessage: null, closed: false, postMessage: (m) => { setImmediate(() => handler(structuredClone(m))); }, terminate() { w.closed = true; } };
  w.deliver = (m) => setImmediate(() => w.onmessage?.({ data: structuredClone(m) }));
  return w;
}
const mk = async () => {
  const api = mockApi(); let w;
  const handler = serveWorker({ api, compileFragment: async (a) => mockCompile(a), slice: 1000, post: (m) => w.deliver(m), tick: nextTick });
  const ctl = new NotebookController({ spawn: () => (w = loopback(handler)) });
  return { ctl, api };
};
const within = (p, ms, what) => Promise.race([p, new Promise((_, rj) => setTimeout(() => rj(new Error('deadline: ' + what)), ms))]);
const dec = (h) => new TextDecoder().decode(Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16)));
// R1: a Stop that reaches the worker before the cell starts (during open/compile, or between cells of Run all) is not dropped.
// Driven straight at the worker handle, messages delivered back to back (no event-loop turn between them).
async function stopLatch() {
  const mkw = () => { const out = []; const api = mockApi();
    const h = serveWorker({ api, compileFragment: async (a) => mockCompile(a), slice: 1000, post: (m) => out.push(m), tick: nextTick });
    const got = (f, what) => within((async () => { for (;;) { const m = out.find(f); if (m) return m; await new Promise((r) => setImmediate(r)); } })(), 10000, what);
    return { h, out, got }; };
  { const { h, got } = mkw();
    h({ t: 'load', cells: [{ id: 'L', src: 'loop 100000\nemit end', kind: 'code' }] }); await got((m) => m.t === 'ready', 'ready');
    h({ t: 'run', rid: 1, id: 'L', src: 'loop 100000\nemit end' }); h({ t: 'stop', rid: 1 });
    const d = await got((m) => m.t === 'done' && m.rid === 1, 'done after early Stop');
    check(d.row.interrupted === true && d.row.steps < 1000, 'R1 early Stop (before the cell starts) is honoured: cell reported interrupted, not run to the end');
    h({ t: 'run', rid: 2, id: 'L', src: 'loop 3\nemit end' });
    const d2 = await got((m) => m.t === 'done' && m.rid === 2, 'done of the next run');
    check(!d2.row.interrupted && dec(d2.row.stdout_hex) === '...end', 'R1 the latch is per request: the next run is not stopped'); }
  { const { h, out, got } = mkw();
    const cells = [{ id: 'A', src: 'emit a', kind: 'code' }, { id: 'B', src: 'emit b', kind: 'code' }];
    h({ t: 'load', cells }); h({ t: 'runall', rid: 1, cells }); h({ t: 'stop', rid: 1 });
    await got((m) => m.t === 'done' && m.all && m.rid === 1, 'Run all done after early Stop');
    check(!out.some((m) => m.t === 'done' && m.id === 'B'), 'R1 Run all: a Stop sent before/between cells ends the run; later cells do not run'); }
  // page side: the controller sends the rid of the active request with Stop
  { const sent = []; const w = { postMessage: (m) => sent.push(m), terminate() {} }; const ctl = new NotebookController({ spawn: () => w });
    ctl.setCell('A', 'emit a'); ctl.run('A'); ctl.w.onmessage({ data: { t: 'ready' } }); await new Promise((r) => setImmediate(r)); ctl.stop();
    check(sent.some((m) => m.t === 'stop' && m.rid === 1), 'R1 controller.stop() carries the active request id'); }
}
// R2: worker death (error event / terminate): waiting runs fail by name, nothing stays busy or 'running', the next run respawns.
async function workerDeath() {
  let w, spawns = 0;
  const spawn = () => { spawns++; const api = mockApi(); let ww;
    const handler = serveWorker({ api, compileFragment: async (a) => mockCompile(a), slice: 1000, post: (m) => { if (!ww.dead) ww.deliver(m); }, tick: nextTick });
    ww = loopback((m) => { if (!ww.dead) handler(m); }); ww.die = () => { ww.dead = true; ww.onerror?.({ message: 'boom' }); }; return (w = ww); };
  const ctl = new NotebookController({ spawn });
  ctl.setCell('A', 'def v=1\nemit a'); ctl.setCell('L', 'loop 100000');
  await within(ctl.run('A'), 10000, 'first run');
  const p = ctl.run('L'); await within((async () => { while (ctl.cells.get('L').steps < 20) await new Promise((r) => setTimeout(r, 2)); })(), 10000, 'progress');
  w.die(); const e = await within(p, 10000, 'reply after worker death');
  check(e.t === 'error' && e.name === 'WorkerLost', 'R2 worker error event: the waiting run fails with WorkerLost');
  check(!ctl.busy() && ctl.cells.get('L').status === 'refused' && ctl.owners.size === 0, 'R2 not busy, running cell marked refused, symbol table forgotten');
  const r = await within(ctl.run('A'), 10000, 'run after death');
  check(spawns === 2 && r.row && !r.row.interrupted && dec(r.row.stdout_hex) === 'a', 'R2 the next run starts a fresh worker and completes');
  const q = ctl.run('L'); await within((async () => { while (ctl.cells.get('L').steps < 20) await new Promise((r) => setTimeout(r, 2)); })(), 10000, 'progress 2');
  ctl.close(); const e2 = await within(q, 10000, 'reply after close');
  check(e2.name === 'WorkerLost' && !ctl.busy() && ctl.w === null, 'R2 close() fails the waiting run and leaves the controller idle');
}
try { await scenarios(mk, check); await stopLatch(); await workerDeath(); } catch (e) { console.log('FAIL', e.stack); bad++; }
console.log(bad ? `FAIL ${bad}` : 'PASS');
process.exit(bad ? 1 : 0);
