// SPDX-License-Identifier: AGPL-3.0-only
// BR-11 scenarios over a NotebookController whose worker is whatever `mk()` builds (node loopback, or a real Worker in the page).
// mk() -> {ctl, api?}; check(ok, what). Cell language: see test/mock-machine.mjs.
const dec = (h) => new TextDecoder().decode(Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// every await on a worker reply has a deadline: a lost reply FAILs, never hangs
const within = (p, ms, what) => Promise.race([p, new Promise((_, rj) => setTimeout(() => rj(new Error('deadline: ' + what)), ms))]);
async function until(f, ms = 5000) { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(2); } }

export async function scenarios(mk, check) {
  // 1. stop mid-cell: partial output kept and marked, state kept, the next cell still sees cell A's value
  { const { ctl, api } = await mk();
    ctl.setCell('A', 'def x=7\nemit A'); ctl.setCell('L', 'def y=1\nloop 100000\nemit end'); ctl.setCell('B', 'need x\nemit x=$x');
    await ctl.run('A');
    const p = ctl.run('L');
    await until(() => ctl.cells.get('L').steps >= 30);
    check(ctl.cells.get('L').status === 'running' && ctl.cells.get('L').partial.length > 0, 'progress: steps and partial output shown while the cell runs');
    const st = await ctl.poll(); check(st.state === 'running' && st.id === 'L' && st.steps >= 30, 'poll answers mid-cell (running, cell id, steps)');
    ctl.stop(); const d = await within(p, 10000, 'reply after Stop');
    const L = ctl.cells.get('L');
    check(d.row.interrupted && L.status === 'stopped' && /^\.+$/.test(dec(d.row.stdout_hex)) && d.row.steps < 1e6, `stop mid-cell: marked interrupted, partial stdout kept (${dec(d.row.stdout_hex).length} dots)`);
    check(api.log.restores === 1 && api.log.resets === 0, 'stop keeps state: effects restored from snapshot, no machine reset');
    const b = await ctl.run('B'); check(dec(b.row.stdout_hex) === 'x=7', 'after the stop, cell B still reads cell A\'s value (state kept)');
    check((await ctl.poll()).state === 'idle', 'poll after the stop: idle');
    // 2. resume = run the stopped cell again: it completes and replaces the interrupted result
    ctl.cells.get('L').src = 'def y=1\nloop 5\nemit end';
    const r = await ctl.run('L');
    check(!r.row.interrupted && ctl.cells.get('L').status === 'done' && dec(r.row.stdout_hex) === '.....end', 'resume: re-running the stopped cell completes; its result replaces the interrupted one');
    ctl.close(); }
  // 3. re-running cell N replaces its result and its symbols; dependants are badged stale
  { const { ctl } = await mk();
    ctl.setCell('A', 'def v=1\nemit a1'); ctl.setCell('B', 'need v\nemit v=$v'); ctl.setCell('C', 'emit free');
    await ctl.run('A'); await ctl.run('B'); await ctl.run('C');
    check(ctl.stale().length === 0, 'no stale badge after a clean first pass');
    ctl.cells.get('A').src = 'def v=2\nemit a2';
    const a = await ctl.run('A');
    check(dec(a.row.stdout_hex) === 'a2' && dec(ctl.cells.get('A').row.stdout_hex) === 'a2', 're-running cell A replaces its result');
    check(JSON.stringify(ctl.stale()) === '["B"]' && !ctl.isStale('C') && !ctl.isStale('A'), 'stale badge on B (depends on A) only, not on C or A');
    const b = await ctl.run('B'); check(dec(b.row.stdout_hex) === 'v=2' && ctl.stale().length === 0, 'B re-run sees the replaced value and loses the badge');
    ctl.cells.get('A').src = 'def v=3\nloop 1000000'; const pa = ctl.run('A'); await until(() => ctl.cells.get('A').steps >= 20); ctl.stop(); await within(pa, 10000, 'reply after Stop (re-run)');
    check(ctl.stale().length === 0, 'a stopped re-run replaces nothing, so no stale badge');
    const b2 = await ctl.run('B'); check(dec(b2.row.stdout_hex) === 'v=2', 'the stopped re-run left the old value in place');
    ctl.close(); }
  // 4. Run all = restart: clean machine, every result recomputed, badges cleared; a stopped Run all stops at the cell
  { const { ctl, api } = await mk();
    ctl.setCell('A', 'def v=1\nemit a'); ctl.setCell('B', 'need v\nemit v=$v');
    await ctl.run('A'); await ctl.run('B'); ctl.cells.get('A').src = 'def v=9\nemit a'; await ctl.run('A');
    check(ctl.isStale('B'), 'precondition: B stale');
    const r = await ctl.runAll();
    check(api.log.resets === 1 && r.all && ctl.stale().length === 0 && dec(ctl.cells.get('B').row.stdout_hex) === 'v=9', 'Run all = restart: one machine reset, B recomputed from the new A, no stale badges');
    ctl.setCell('C', 'loop 1000000'); ctl.setCell('D', 'emit never');
    const p = ctl.runAll(); await until(() => ctl.cells.get('C').steps >= 20); ctl.stop(); await within(p, 10000, 'Run all reply after Stop');
    check(ctl.cells.get('C').status === 'stopped' && ctl.cells.get('D').row === null, 'a stopped Run all stops at the interrupted cell; later cells do not run');
    ctl.cells.get('C').src = 'loop 3';
    const again = await ctl.runAll(); check(again.all && ctl.cells.get('D').status === 'done' && dec(ctl.cells.get('C').row.stdout_hex) === '...', 'after a stopped Run all, Run all runs every cell again');
    ctl.close(); }
  // 5. busy + refusals by name; a compile error leaves old symbols
  { const { ctl } = await mk();
    ctl.setCell('A', 'def v=1'); ctl.setCell('X', 'bogus'); ctl.setCell('L', 'loop 1000000');
    await ctl.run('A');
    const x = await ctl.run('X'); check(x.row?.refusal === 'CompileError' && ctl.cells.get('X').status === 'refused', 'a compile error is a named refusal on the cell, not a crash');
    const p = ctl.run('L'); await until(() => ctl.cells.get('L').steps >= 20);
    const busy = await ctl.run('A'); check(busy.name === 'Busy', 'a second run while one is active is refused (Busy)');
    ctl.stop(); await within(p, 10000, 'reply after Stop (busy)'); ctl.close(); }
}
