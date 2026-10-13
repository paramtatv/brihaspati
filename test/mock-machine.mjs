// SPDX-License-Identifier: AGPL-3.0-only
// A MOCK machine implementing the machine.mjs contract (BR-11: the page protocol is built against it; the .t1 interpreter
// does not exist yet). Cell language, one op per line:  def NAME=VALUE | need NAME | emit TEXT ($NAME expands) | loop N | steps N
// `loop N` yields N times (10 steps and one '.' each). State (vars) lives in the machine across cells; snapshot/restore real.
import { MACHINE_CALLS, MachineRefusal } from '../kernel/machine.mjs';
const te = new TextEncoder();

export function mockCompile({ src }) {
  const ops = [], defines = [], needs = [];
  for (const [i, raw] of src.split('\n').entries()) {
    const l = raw.trim(); if (!l) continue;
    const [op, ...r] = l.split(/\s+/), rest = r.join(' ');
    if (op === 'def') { const [n, v] = rest.split('='); ops.push({ op, n, v }); defines.push(n); }
    else if (op === 'need') { ops.push({ op, n: rest }); needs.push(rest); }
    else if (op === 'emit') ops.push({ op, text: rest });
    else if (op === 'loop') ops.push({ op, n: Number(rest) });
    else if (op === 'steps') ops.push({ op, n: Number(rest) });
    else throw new MachineRefusal('CompileError', 'compileFragment', `line ${i + 1}: unknown op ${op}`);
  }
  return { fragment: { ops }, defines, needs };
}

export function mockApi({ snapshots = true } = {}) {
  const log = { resets: 0, restores: 0, links: 0 };
  const api = {
    log,
    async machine_new() { return { vars: new Map(), out: [], cur: null, pc: 0, loopLeft: null, steps: 0 }; },
    machine_reset(m) { log.resets++; m.vars.clear(); m.out = []; m.cur = null; m.steps = 0; },
    machine_drop() {},
    load() { throw new MachineRefusal('Unsupported', 'load', 'mock links fragments only'); },
    link(m, frag) { log.links++; m.cur = frag; m.pc = 0; m.loopLeft = null; m.steps = 0; },
    run(m, budget) {
      let used = 0;
      for (;;) {
        const o = m.cur.ops[m.pc];
        if (!o) return { kind: 'exit', status: 0, steps: used, halt: 'exit status 0' };
        if (o.op === 'def') m.vars.set(o.n, o.v);
        else if (o.op === 'emit') m.out.push(o.text.replace(/\$(\w+)/g, (_, n) => m.vars.get(n) ?? '?'));
        else if (o.op === 'steps') used += o.n;
        else if (o.op === 'loop') {
          m.loopLeft ??= o.n;
          if (m.loopLeft > 0) { m.loopLeft--; used += 10; m.out.push('.'); return { kind: 'yield', steps: 10, halt: '' }; }
          m.loopLeft = null;
        }
        m.pc++;
      }
    },
    snapshot(m) { return { vars: new Map(m.vars) }; },
    restore(m, s) { log.restores++; m.vars = new Map(s.vars); },
    out_take(m) { const b = te.encode(m.out.join('')); m.out = []; return b; },
    input_put() {}, files_list() { return []; }, files_read() { throw new MachineRefusal('Unsupported', 'files_read', 'mock'); },
    files_write() {}, files_delete() {},
    steps(m) { return m.steps; }, water() { return 0; },
    capabilities() { return { snapshot: snapshots, yield: true, link: true }; },
  };
  for (const k of MACHINE_CALLS) if (typeof api[k] !== 'function') throw new Error('mock incomplete: ' + k);
  return api;
}
