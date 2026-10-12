// SPDX-License-Identifier: AGPL-3.0-only
// बृहस्पति L28: the machine interface M1-M10 (agent-handovers/T1-INTERPRETER.md, "Step 0") as a JS contract,
// and an ADAPTER that implements it over today's yantra-wasm (one image per run, nothing resident between runs).
// What the engine cannot do today is REFUSED BY NAME (MachineRefusal), never faked:
//   M4 resume after a run, M5 snapshot/restore, load at an address, a second image, fragment link, host file write/delete.
// The default path (kernel/core.mjs compileAndRun) is untouched; compileAndRunViaMachine below re-expresses it
// through this interface and test/machine.mjs requires the same row, field for field.
import { ramFor, sha256, hex, RUN_STEPS, COMPILE_RAM, FILES_TOTAL, FILE_MAX } from './core.mjs';

// The contract: every implementation exports exactly these calls (M-number in the comment).
export const MACHINE_CALLS = [
  'machine_new', 'machine_reset', 'machine_drop',          // M1
  'load', 'link',                                          // M2 (link = fragment into the live image, Q2)
  'run',                                                   // M3 (+M4: run after a Yield resumes)
  'snapshot', 'restore',                                   // M5
  'out_take',                                              // M6
  'input_put',                                             // M7
  'files_list', 'files_read', 'files_write', 'files_delete', // M8
  'steps', 'water',                                        // M9
  'capabilities',                                          // which of the above are real on this engine
];
// Stop kinds returned by run (M3): 'exit' {status}, 'steplimit', 'fault' {code}, 'yield'. All carry {halt, steps}.
export const STOP_KINDS = ['exit', 'steplimit', 'fault', 'yield'];

// A named refusal. name: 'Unsupported' | 'AllocationRefused' | 'MachineState' | ...; call = the interface call.
export class MachineRefusal extends Error {
  constructor(name, call, why, extra = {}) { super(`${name}: ${call}: ${why}`); this.name = name; this.call = call; this.why = why; Object.assign(this, extra); }
}
const unsupported = (call, why) => new MachineRefusal('Unsupported', call, why);

export function assertImplements(api) {
  const missing = MACHINE_CALLS.filter((k) => typeof api[k] !== 'function');
  if (missing.length) throw new MachineRefusal('ContractIncomplete', 'assertImplements', `missing: ${missing.join(',')}`);
  return api;
}

// entry and extent of an ELF image (the values load returns); extent = max(vaddr+memsz) - min(vaddr) over PT_LOAD.
export function elfInfo(elf) {
  const dv = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  if (elf.length < 64 || dv.getUint32(0, false) !== 0x7f454c46) throw new MachineRefusal('BadImage', 'load', 'not an ELF image');
  const phoff = Number(dv.getBigUint64(32, true)), phentsize = dv.getUint16(54, true), phnum = dv.getUint16(56, true);
  let lo = Infinity, hi = 0;
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    if (dv.getUint32(o, true) !== 1) continue;
    const vaddr = Number(dv.getBigUint64(o + 16, true)), memsz = Number(dv.getBigUint64(o + 40, true));
    lo = Math.min(lo, vaddr); hi = Math.max(hi, vaddr + memsz);
  }
  return { entry: Number(dv.getBigUint64(24, true)), extent: hi > lo ? hi - lo : 0 };
}

const enc = new TextEncoder(), dec = new TextDecoder();

// ---- the adapter over yantra-wasm. wasm: Uint8Array of vendor/yantra_wasm.wasm. ----
export function yantraWasmMachineApi(wasm) {
  let module = null;
  const live = (m, call) => {
    if (!m || m.state === 'dropped') throw new MachineRefusal('MachineState', call, 'machine is dropped or unknown');
    return m;
  };
  const api = {
    // M1. ram in octets (reset may change it); opts.files = {total, file} caps for the program's file root (omit: no file root, as for the compiler).
    async machine_new(ram, opts = {}) {
      module ??= await WebAssembly.compile(wasm);
      const instance = await WebAssembly.instantiate(module, {});
      return { state: 'fresh', ram, caps: opts.files ?? null, instance, image: null, input: new Uint8Array(0), name: new Uint8Array(0),
        out: new Uint8Array(0), halt: '', stepsN: null, waterN: null, files: [], capsOn: false };
    },
    // Back to a fresh machine (same engine instance, image and files dropped). ram may change.
    machine_reset(m, ram, opts) {
      live(m, 'machine_reset');
      if (m.capsOn) m.instance.exports.yantra_memfs_disable();
      Object.assign(m, { state: 'fresh', image: null, input: new Uint8Array(0), name: new Uint8Array(0), out: new Uint8Array(0),
        halt: '', stepsN: null, waterN: null, files: [], capsOn: false });
      if (ram !== undefined) m.ram = ram;
      if (opts && opts.files !== undefined) m.caps = opts.files;
    },
    machine_drop(m) { if (m) { m.state = 'dropped'; m.instance = null; m.image = null; m.files = []; m.out = new Uint8Array(0); } },
    // M2. yantra places an image at its own vaddrs in cleared RAM: no `at`, one image, only on a fresh machine.
    load(m, elf, at) {
      live(m, 'load');
      if (at !== undefined && at !== null) throw unsupported('load', 'yantra-wasm places an image at its ELF vaddrs; a load address is not supported');
      if (m.image) throw unsupported('load', 'a second image: yantra-wasm holds one image per run');
      if (m.state !== 'fresh') throw unsupported('load', 'load into a machine that has already run (RAM is wiped by each run); use machine_reset');
      const info = elfInfo(elf);
      m.image = elf;
      return info;
    },
    // M2 / Q2: link a compiled fragment into the live image.
    link(m, _fragment, _symbols) { live(m, 'link'); throw unsupported('link', 'fragment linking into a live image needs the new compiler mode and the .t1 interpreter; today one image per run'); },
    // M3. budget in steps. Returns the stop. Never returns 'yield' (this engine has no slice).
    run(m, budget) {
      live(m, 'run');
      if (!m.image) throw new MachineRefusal('MachineState', 'run', 'no image loaded');
      if (m.state === 'ran') throw unsupported('run', 'M4: resume after a run; the engine ends a run at its stop and keeps nothing resident');
      if (m.ram > 2 ** 32) throw new MachineRefusal('AllocationRefused', 'run', `wanted ${Math.ceil(m.ram / 2 ** 20)} MiB of guest RAM; wasm32 holds at most 4096 MiB`, { mib: Math.ceil(m.ram / 2 ** 20) });
      const e = m.instance.exports;
      const mem = () => new Uint8Array(e.memory.buffer);   // re-read: an alloc can grow (detach) memory
      const put = (alloc, bytes) => { const at = alloc(bytes.length); if (bytes.length) mem().set(bytes, at); };
      if (m.caps) { if (e.yantra_memfs_enable_caps(m.caps.total, m.caps.file) !== 0) throw new MachineRefusal('MachineState', 'run', 'memfs caps refused'); m.capsOn = true; }
      put(e.yantra_alloc, m.image);
      put(e.yantra_input_alloc, m.input);          // 0 bytes clears the previous run's slab
      put(e.yantra_input_name_alloc, m.name);
      let code;
      try { code = e.yantra_run(m.ram, budget); }
      catch (err) {   // the guest RAM is a Vec the engine allocates in wasm linear memory; a failed grow traps
        m.state = 'ran';
        throw new MachineRefusal('AllocationRefused', 'run', `could not allocate ${Math.ceil(m.ram / 2 ** 20)} MiB of guest RAM (${err && err.message ? err.message : err})`, { mib: Math.ceil(m.ram / 2 ** 20) });
      }
      const p = e.yantra_out_ptr(), n = e.yantra_out_len(), h = e.yantra_halt_ptr(), hn = e.yantra_halt_len();
      m.out = mem().slice(p, p + n);     // raw octets
      m.halt = dec.decode(mem().slice(h, h + hn));
      m.waterN = e.yantra_water_known() === 1 ? e.yantra_water() >>> 0 : null;
      m.stepsN = e.yantra_steps_known() === 1 ? (e.yantra_steps_hi() >>> 0) * 2 ** 32 + (e.yantra_steps_lo() >>> 0) : null;
      m.files = [];
      if (m.capsOn) for (let i = 0, c = e.yantra_memfs_count(); i < c; i++) {
        const np = e.yantra_memfs_name(i), nl = e.yantra_memfs_name_len(i), dp = e.yantra_memfs_data(i), dl = e.yantra_memfs_data_len(i);
        m.files.push({ name: dec.decode(mem().slice(np, np + nl)), bytes: mem().slice(dp, dp + dl) });
      }
      m.state = 'ran';
      const base = { halt: m.halt, steps: m.stepsN };
      if (code === 0) return { kind: 'exit', status: 0, ...base };
      if (code === 1) { const x = /exit status (\d+)/.exec(m.halt); return { kind: 'exit', status: x ? Number(x[1]) : null, ...base }; }
      if (code === 5) return { kind: 'steplimit', budget, ...base };
      return { kind: 'fault', code, ...base };
    },
    // M5
    snapshot(m) { live(m, 'snapshot'); throw unsupported('snapshot', 'M5: the engine keeps its state outside the host; no snapshot'); },
    restore(m, _s) { live(m, 'restore'); throw unsupported('restore', 'M5: the engine keeps its state outside the host; no restore'); },
    // M6: this run's stdout octets, raw, then cleared.
    out_take(m) { live(m, 'out_take'); const o = m.out; m.out = new Uint8Array(0); return o; },
    // M7: input slab + name, applied at the next run. name: string or bytes.
    input_put(m, bytes, name = new Uint8Array(0)) {
      live(m, 'input_put');
      m.input = bytes; m.name = typeof name === 'string' ? enc.encode(name) : name;
    },
    // M8: the program's file root as of the last run. Host-side write/delete are not wired in the engine ABI.
    files_list(m) { live(m, 'files_list'); return m.files.map((f) => ({ name: f.name, length: f.bytes.length })); },
    files_read(m, name) {
      live(m, 'files_read');
      const f = m.files.find((x) => x.name === name);
      if (!f) throw new MachineRefusal('NoSuchFile', 'files_read', `no file ${name}`);
      return f.bytes;
    },
    files_write(m, _name, _bytes) { live(m, 'files_write'); throw unsupported('files_write', 'host-side file write: the file root is not seedable through the pinned yantra-wasm ABI'); },
    files_delete(m, _name) { live(m, 'files_delete'); throw unsupported('files_delete', 'host-side file delete: not in the pinned yantra-wasm ABI'); },
    // M9: of the last run; null before the first run (or if the engine does not know).
    steps(m) { return live(m, 'steps').stepsN; },
    water(m) { return live(m, 'water').waterN; },
    capabilities() {
      return { resident_image: false, resume: false, snapshot: false, load_at: false, multi_image: false, link_fragment: false,
        yield: false, files_host_write: false, files_host_delete: false };
    },
  };
  return assertImplements(api);
}

// The default path re-expressed through the interface (one machine, reset between the compile and the run, as the
// legacy code reuses one engine instance). Returns the row compileAndRun returns (same fields, same values).
export async function compileAndRunViaMachine(api, stage1, src, pins, { runSteps = RUN_STEPS, fileCaps = { total: FILES_TOTAL, file: FILE_MAX } } = {}) {
  const firstLine = src.split('\n')[0].trim().split(/\s+/);
  if (firstLine[1] !== pins.module || !src.includes(`सार्वजनिक वृत्तिः ${pins.entry} ददाति`)) {
    return { error: 'CellShapeRefused', why: `a cell must be module ${pins.module} with entry routine ${pins.entry} (the default entry of the v1.0.2 image; an entry from the input is not used yet)` };
  }
  const nameB = enc.encode(firstLine[1]), srcB = enc.encode(src);
  const blob = new Uint8Array(nameB.length + 1 + srcB.length + 1);   // `name NUL text NUL`
  blob.set(nameB, 0); blob.set(srcB, nameB.length + 1);
  const m = await api.machine_new(COMPILE_RAM);
  try {
    api.load(m, stage1);
    api.input_put(m, blob, nameB);
    const t0 = performance.now();
    const cs = api.run(m, 4_000_000_000);
    const wall = (performance.now() - t0) / 1000;
    const cout = api.out_take(m);
    const off = indexOfSeq(cout, [0x7f, 0x45, 0x4c, 0x46]);
    if (off < 0 || cs.kind !== 'exit' || cs.status !== 1200) return { error: 'compile', compile_status: cs.kind === 'exit' ? cs.status : `halt:${cs.kind === 'steplimit' ? 5 : cs.code}`, halt: cs.halt };
    const elf = cout.slice(off, cout.length - 1);
    const ram = ramFor(elf);
    if (ram > 2 ** 32) return { error: 'RamTooLarge', why: `the emitted image needs ${Math.ceil(ram / 2 ** 20)} MiB of guest RAM; wasm32 holds at most 4096 MiB` };
    const stepsCompile = api.steps(m);
    api.machine_reset(m, ram, { files: fileCaps });   // the program (never the compiler) gets the file root
    api.load(m, elf);
    api.input_put(m, new Uint8Array(0), new Uint8Array(0));
    const rs = api.run(m, runSteps);
    const out = api.out_take(m);
    const files = api.files_list(m).map((f) => ({ name: f.name, bytes: api.files_read(m, f.name) }));
    if (rs.kind === 'steplimit') return { error: 'StepLimitExceeded', why: `the cell did not finish within ${runSteps} steps`, halt: rs.halt };
    if (rs.kind === 'fault') return { error: 'EngineHalt', why: `the engine halted the run: ${rs.halt} (code ${rs.code})`, halt: rs.halt };
    return {
      elf, elf_sha256: await sha256(elf), status: rs.status, output: dec.decode(out), output_hex: hex(out),
      steps_compile: stepsCompile, steps_run: rs.steps, ram_run: ram, high_water_run: api.water(m),
      wall_compile_s: Math.round(wall * 1000) / 1000, files,
    };
  } catch (err) {
    if (err instanceof MachineRefusal && err.name === 'AllocationRefused') throw new Error(err.why.replace(/^could not allocate/, 'could not allocate'));
    throw err;
  } finally { api.machine_drop(m); }
}
function indexOfSeq(a, seq) { outer: for (let i = 0; i + seq.length <= a.length; i++) { for (let j = 0; j < seq.length; j++) if (a[i + j] !== seq[j]) continue outer; return i; } return -1; }
