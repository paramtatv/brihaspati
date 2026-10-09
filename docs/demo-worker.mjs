import { compileAndRun } from './core.mjs';
self.onmessage = async (ev) => {
  const { stage1, wasm, src, pins } = ev.data;
  try {
    const r = await compileAndRun(stage1, wasm, src, pins);
    delete r.elf;
    self.postMessage({ ok: true, row: r });
  } catch (err) {
    self.postMessage({ ok: false, message: String(err && err.message || err) });
  }
};
