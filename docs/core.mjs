// बृहस्पति core: compile ONE T1 cell with the pinned Stage 1 image on yantra-wasm, run the
// emitted ELF on yantra-wasm. Environment-neutral (node and browser): bytes in, a result object out.
// kernel/cell.mjs (node CLI), the docs/ demo and the JupyterLite kernel all call this one function.
export const RUN_STEPS = 4_000_000_000;   // identical in kernel/native.py
// The compiler declares a 512 MiB .bss heap and puts its stack above it, so it touches
// ~537 MB; 256 MiB halts "beyond RAM" (code 12). Pages the compiler never writes cost nothing.
export const COMPILE_RAM = 640 << 20;

// The RUN RAM is the native runner's rule (Span::Declared), restated: the larger of 20 MiB
// (DEFAULT_RAM) and the declared extent plus 16 MiB (RAM_HEADROOM); extent = max(vaddr+memsz) - min(vaddr)
// over the PT_LOAD segments (yantra crates/yantra/src/lib.rs).
export function ramFor(elf) {
  const dv = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  const phoff = Number(dv.getBigUint64(32, true)), phentsize = dv.getUint16(54, true), phnum = dv.getUint16(56, true);
  let lo = Infinity, hi = 0;
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    if (dv.getUint32(o, true) !== 1) continue;                    // PT_LOAD
    const vaddr = Number(dv.getBigUint64(o + 16, true)), memsz = Number(dv.getBigUint64(o + 40, true));
    lo = Math.min(lo, vaddr); hi = Math.max(hi, vaddr + memsz);
  }
  const extent = hi > lo ? hi - lo : 0;
  return Math.max(20 << 20, extent + (16 << 20));
}

export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export async function sha256(bytes) {
  return hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)));
}
const indexOfSeq = (a, seq) => { outer: for (let i = 0; i + seq.length <= a.length; i++) { for (let j = 0; j < seq.length; j++) if (a[i + j] !== seq[j]) continue outer; return i; } return -1; };

// stage1, wasm: Uint8Array. src: string. pins: kernel/pins.json. Returns the same row cell.mjs prints.
export async function compileAndRun(stage1, wasm, src, pins, { checkPins = true } = {}) {
  if (checkPins) for (const [b, k] of [[stage1, 'stage1_sha256'], [wasm, 'yantra_wasm_sha256']]) {
    const got = await sha256(b);
    if (got !== pins[k]) return { error: 'PinMismatch', what: k, got };
  }
  const enc = new TextEncoder(), dec = new TextDecoder();
  const srcB = enc.encode(src);
  const firstLine = src.split('\n')[0].trim().split(/\s+/);
  if (firstLine[1] !== pins.module || !src.includes(`सार्वजनिक वृत्तिः ${pins.entry} ददाति`)) {
    return { error: 'CellShapeRefused', why: `a cell must be module ${pins.module} with entry routine ${pins.entry} (the v1.0.1 image has a fixed entry)` };
  }
  const nameB = enc.encode(firstLine[1]);
  const blob = new Uint8Array(nameB.length + 1 + srcB.length + 1);   // `name NUL text NUL`
  blob.set(nameB, 0); blob.set(srcB, nameB.length + 1);

  const { instance } = await WebAssembly.instantiate(wasm, {});
  const e = instance.exports;
  const mem = () => new Uint8Array(e.memory.buffer);   // re-read: an alloc can grow (detach) memory
  const put = (alloc, bytes) => { const at = alloc(bytes.length); if (bytes.length) mem().set(bytes, at); };
  const water = () => e.yantra_water_known() === 1 ? e.yantra_water() >>> 0 : null;
  const steps = () => e.yantra_steps_known() === 1
    ? (e.yantra_steps_hi() >>> 0) * 2 ** 32 + (e.yantra_steps_lo() >>> 0) : null;
  function run(elf, ram, budget, input, name) {
    put(e.yantra_alloc, elf);
    put(e.yantra_input_alloc, input);          // 0 bytes clears the previous run's slab
    put(e.yantra_input_name_alloc, name);
    const code = e.yantra_run(ram, budget);
    const p = e.yantra_out_ptr(), n = e.yantra_out_len(), h = e.yantra_halt_ptr(), hn = e.yantra_halt_len();
    const out = mem().slice(p, p + n);     // raw octets: the sink holds a binary ELF
    const halt = dec.decode(mem().slice(h, h + hn));
    let status;
    if (code === 0) status = 0;
    else if (code === 1) { const m = /exit status (\d+)/.exec(halt); status = m ? Number(m[1]) : null; }
    else status = `halt:${code}`;
    return { out, status, halt, steps: steps(), water: water() };
  }
  const t0 = performance.now();
  const c = run(stage1, COMPILE_RAM, 4_000_000_000, blob, nameB);
  const wall = (performance.now() - t0) / 1000;
  const off = indexOfSeq(c.out, [0x7f, 0x45, 0x4c, 0x46]);
  if (off < 0 || c.status !== 1200) return { error: 'compile', compile_status: c.status, halt: c.halt };
  const elf = c.out.slice(off, c.out.length - 1);   // one marker octet each side of the ELF
  const ram = ramFor(elf);
  const r = run(elf, ram, RUN_STEPS, new Uint8Array(0), new Uint8Array(0));
  return {
    elf, elf_sha256: await sha256(elf), status: r.status, output: dec.decode(r.out), output_hex: hex(r.out),
    steps_compile: c.steps, steps_run: r.steps, ram_run: ram, high_water_run: r.water,
    wall_compile_s: Math.round(wall * 1000) / 1000,
  };
}
