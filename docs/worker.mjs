import { compileAndRun } from './core.mjs';
self.onmessage = async (ev) => {
  const { stage1, wasm, src, pins, fixtureFiles } = ev.data;
  try { const r = await compileAndRun(stage1, wasm, src, pins); delete r.elf; r.files = fixtureFiles || [];   // STUB: files the program wrote; real ones come from yantra-wasm's in-memory patra root
    self.postMessage({ ok: true, row: r }); }
  catch (err) { self.postMessage({ ok: false, message: String((err && err.message) || err) }); }
};
