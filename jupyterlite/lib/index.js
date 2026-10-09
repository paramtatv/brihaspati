// बृहस्पति JupyterLite kernel (phase 1b). JS glue only: a cell is compiled by the pinned self-hosted
// Sassembly compiler on yantra-wasm and run on the same engine, by brihaspati/core.mjs (the same
// file kernel/cell.mjs uses), inside a module Web Worker. The assets are static files of the site:
//   <base>brihaspati/{core.mjs, pins.json, stage1.elf, yantra_wasm.wasm}
import { PageConfig, URLExt } from '@jupyterlab/coreutils';
import { BaseKernel, IKernelSpecs } from '@jupyterlite/services';

import { REFUSALS } from './refusals.js';   // generated from the compiler source: tools/gen-refusals.py
export { REFUSALS };
const ICON = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#2B2521"/><text x="32" y="44" font-size="36" text-anchor="middle" fill="#F4EFE5">बृ</text></svg>');

const WORKER_SRC = `
self.onmessage = async (ev) => {
  const { base, src } = ev.data;
  try {
    const core = await import(base + 'core.mjs');
    const get = async (n) => new Uint8Array(await (await fetch(base + n)).arrayBuffer());
    const pins = await (await fetch(base + 'pins.json')).json();
    const [stage1, wasm] = await Promise.all([get('stage1.elf'), get('yantra_wasm.wasm')]);
    const row = await core.compileAndRun(stage1, wasm, src, pins);
    delete row.elf;
    self.postMessage({ ok: true, row });
  } catch (err) { self.postMessage({ ok: false, message: String((err && err.message) || err) }); }
};`;

function runInWorker(base, src) {
  const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
  const w = new Worker(url, { type: 'module' });
  return new Promise((resolve, reject) => {
    w.onmessage = (ev) => { w.terminate(); URL.revokeObjectURL(url); ev.data.ok ? resolve(ev.data.row) : reject(new Error(ev.data.message)); };
    w.onerror = (ev) => { w.terminate(); URL.revokeObjectURL(url); reject(new Error(ev.message || 'worker failed')); };
    w.postMessage({ base, src });
  });
}

export class BrihaspatiKernel extends BaseKernel {
  async kernelInfoRequest() {
    return {
      implementation: 'brihaspati', implementation_version: '0.1.0',
      language_info: { name: 'sassembly', version: '1.0.1', mimetype: 'text/plain', file_extension: '.t1', codemirror_mode: 'text' },
      banner: 'बृहस्पति: T1 cells compiled by the self-hosted Sassembly v1.0.1 compiler on yantra-wasm',
      help_links: [], protocol_version: '5.3', status: 'ok',
    };
  }

  async executeRequest(content) {
    const count = this.executionCount;
    const fail = (ename, evalue) => {
      this.publishExecuteError({ ename, evalue, traceback: [ename + ': ' + evalue] });
      return { status: 'error', execution_count: count, ename, evalue, traceback: [ename + ': ' + evalue] };
    };
    const base = URLExt.join(PageConfig.getBaseUrl(), 'brihaspati/');
    let row;
    try { row = await runInWorker(base, content.code.replace(/^\s*\n/, '').replace(/\s+$/, '') + '\n'); }
    catch (err) { return fail('BrihaspatiError', String(err.message || err)); }
    if (row.error) return fail(row.error, row.why || (row.error === 'compile' ? 'compile status ' + row.compile_status + ' ' + (row.halt || '') : JSON.stringify(row)));
    if (row.output) this.stream({ name: 'stdout', text: row.output });
    const name = REFUSALS[row.status];
    if (name) return fail(name, String(row.status));
    const result = { status: row.status, steps_compile: row.steps_compile, steps_run: row.steps_run };
    this.publishExecuteResult({
      execution_count: count,
      data: { 'application/json': result, 'text/plain': JSON.stringify(result) },
      metadata: {},
    });
    return { status: 'ok', execution_count: count, user_expressions: {} };
  }

  async completeRequest() { return { matches: [], cursor_start: 0, cursor_end: 0, metadata: {}, status: 'ok' }; }
  async inspectRequest() { return { status: 'ok', found: false, data: {}, metadata: {} }; }
  async isCompleteRequest() { return { status: 'unknown' }; }
  async commInfoRequest() { return { comms: {}, status: 'ok' }; }
  inputReply() {}
  async commOpen() {}
  async commMsg() {}
  async commClose() {}
}

const plugin = {
  id: 'brihaspati-jupyterlite-kernel:kernel',
  description: 'The बृहस्पति kernel',
  autoStart: true,
  requires: [IKernelSpecs],
  activate: (app, kernelspecs) => {
    kernelspecs.register({
      spec: {
        name: 'brihaspati', display_name: 'बृहस्पति', language: 'sassembly', argv: [],
        resources: { 'logo-32x32': ICON, 'logo-64x64': ICON },
      },
      create: async (options) => new BrihaspatiKernel(options),
    });
  },
};
export default [plugin];
