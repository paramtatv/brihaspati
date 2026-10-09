// Headless Chromium: open the JupyterLite site's notebook, run ALL cells with the बृहस्पति kernel, and assert each
// cell's outputs EXACTLY equal native's (cells/expected.jsonl, and two cells run natively during this test).
// Also: the site under test must be the one built from this source (asset hashes), a page error fails the test,
// and a killed or hung worker must end its cell with a named error without stacking workers.
// usage: PLAYWRIGHT=<dir of playwright-core> [CHROME=/usr/bin/google-chrome] node test/notebook.mjs [outdir]
// needs: site/ (sh tools/build-site.sh) and vendor/yantra-run (the native runner, for the live native cells)
import { readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { REFUSALS } from '../jupyterlite/lib/refusals.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ?? '.';
mkdirSync(out, { recursive: true });
const { chromium } = await import(pathToFileURL(join(process.env.PLAYWRIGHT, 'index.mjs')).href);
const expected = Object.fromEntries(readFileSync(join(root, 'cells/expected.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { const j = JSON.parse(l); return [j.cell, j]; }));
const cells = readdirSync(join(root, 'cells')).filter((f) => f.endsWith('.t1')).sort();
const pins = JSON.parse(readFileSync(join(root, 'kernel/pins.json'), 'utf8'));
let bad = 0;
const check = (ok, what) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) bad++; };
const sha = (b) => createHash('sha256').update(b).digest('hex');

// 0. the site must be the build of THIS source: assets by hash, extension by the refusal names it carries, notebook by cells
const site = join(root, 'site');
for (const [pub, src] of [['core.mjs', 'kernel/core.mjs'], ['pins.json', 'kernel/pins.json']])
  check(existsSync(join(site, 'brihaspati', pub)) && sha(readFileSync(join(site, 'brihaspati', pub))) === sha(readFileSync(join(root, src))), `site asset ${pub} == ${src}`);
for (const [pub, key] of [['stage1.elf', 'stage1_sha256'], ['yantra_wasm.wasm', 'yantra_wasm_sha256']])
  check(existsSync(join(site, 'brihaspati', pub)) && sha(readFileSync(join(site, 'brihaspati', pub))) === pins[key], `site asset ${pub} == pinned ${key}`);
const extDir = join(site, 'extensions/brihaspati-jupyterlite-kernel/static');
const extJs = existsSync(extDir) ? readdirSync(extDir).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(extDir, f), 'utf8')).join('\n') : '';
check(Object.values(REFUSALS).every((n) => extJs.includes(n)) && extJs.includes('BrihaspatiTimeout'), 'site kernel extension carries the current refusal names and worker guards');
const strip = (f) => readFileSync(join(root, 'jupyterlite/lib', f), 'utf8').split('\n').filter((l) => !/^import \{ SRC_SHA256 \}/.test(l) && l !== 'export { SRC_SHA256 };').join('\n');
const srcSha = sha(Buffer.from(strip('index.js') + strip('refusals.js')));
check(extJs.includes(srcSha), `site extension bundle carries the sha256 of jupyterlite/lib/index.js + refusals.js (${srcSha.slice(0, 12)})`);
const nbSite = JSON.parse(readFileSync(join(site, 'files/demo.ipynb'), 'utf8'));
check(isDeepStrictEqual(nbSite.cells.map((c) => c.source), cells.map((c) => readFileSync(join(root, 'cells', c), 'utf8'))), `site notebook has the ${cells.length} cells of cells/*.t1`);
if (bad) process.exit(1);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.ipynb': 'application/json', '.elf': 'application/octet-stream', '.map': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(site, normalize(p));
  try { if (existsSync(f) && !extname(f)) f = join(f, 'index.html'); const b = readFileSync(f); res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(404); res.end(); }
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}/lab/index.html?path=demo.ipynb`;

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));

// run cell i through the notebook's own command; resolve with its model JSON once it has a NEW execution count and output
const runCell = async (i, until = '') => {
  const before = await page.evaluate((i) => window.jupyterapp.shell.currentWidget.model.toJSON().cells[i].execution_count, i);
  await page.evaluate(async (i) => { const nb = window.jupyterapp.shell.currentWidget.content; nb.activeCellIndex = i; await window.jupyterapp.commands.execute('notebook:run-cell'); }, i);
  await page.waitForFunction(([i, before, until]) => {
    const c = window.jupyterapp.shell.currentWidget.model.toJSON().cells[i];
    return c.execution_count !== null && c.execution_count !== before && c.outputs.length > 0 && JSON.stringify(c.outputs).includes(until);
  }, [i, before, until], { timeout: 300000 });
  return page.evaluate((i) => window.jupyterapp.shell.currentWidget.model.toJSON().cells[i].outputs, i);
};
// the outputs a cell must have, from a native row
const wantOutputs = (row) => {
  const o = [];
  if (row.error) return [{ output_type: 'error', ename: row.error, evalue: row.why }];
  if (row.output) o.push({ output_type: 'stream', name: 'stdout', text: row.output });
  if (REFUSALS[row.status]) o.push({ output_type: 'error', ename: REFUSALS[row.status], evalue: String(row.status) });
  else o.push({ output_type: 'execute_result', data: { 'application/json': { status: row.status, steps_compile: row.steps_compile, steps_run: row.steps_run }, 'text/plain': JSON.stringify({ status: row.status, steps_compile: row.steps_compile, steps_run: row.steps_run }) } });
  return o;
};
const project = (outs) => outs.map((o) => o.output_type === 'error' ? { output_type: 'error', ename: o.ename, evalue: o.evalue }
  : o.output_type === 'stream' ? { output_type: 'stream', name: o.name, text: Array.isArray(o.text) ? o.text.join('') : o.text }
  : { output_type: o.output_type, data: o.data });
const got = {};
try {
  await page.goto(url);
  await page.waitForFunction(() => window.jupyterapp && window.jupyterapp.shell.currentWidget && window.jupyterapp.shell.currentWidget.model && window.jupyterapp.shell.currentWidget.model.cells.length > 0, null, { timeout: 120000 });
  await page.evaluate(() => window.jupyterapp.shell.currentWidget.sessionContext.ready);
  for (let i = 0; i < cells.length; i++) {
    got[cells[i]] = project(await runCell(i));
    const want = wantOutputs(expected[cells[i]]);
    check(isDeepStrictEqual(got[cells[i]], want), `${cells[i]}: outputs EXACTLY equal native's ${JSON.stringify(want.map((w) => w.ename ? w.ename + ' ' + w.evalue : w.output_type)).slice(0, 110)}`);
  }
  check([...new Set(cells.filter((c) => REFUSALS[expected[c].status]).map((c) => expected[c].status))].sort().join() === '853,860,861,862', 'all four refusals (853, 860, 861, 862) are among the cells');

  // two cells run NATIVELY now (not from expected.jsonl): the notebook's outputs equal the live native row
  for (const c of ['print_x.t1', 'division_by_zero_refusal.t1']) {
    let row; try { row = JSON.parse(execFileSync('sh', [join(root, 'kernel/native.sh'), join(root, 'cells', c)], { encoding: 'utf8' })); } catch (e) { row = null; console.log(String(e.message).slice(0, 200)); }
    check(row && isDeepStrictEqual(got[c], wantOutputs(row)), `${c}: notebook outputs equal a native run made during this test`);
  }

  // --- worker failures: a killed worker and a hung worker must END the cell with a named error, and a re-run
  // must never leave two workers alive. Worker is wrapped to count live workers.
  await page.evaluate(() => {
    const W = window.Worker; window.__live = 0; window.__maxLive = 0; window.__mode = 'normal';
    window.Worker = function (...a) {
      const w = new W(...a); window.__live++; window.__maxLive = Math.max(window.__maxLive, window.__live);
      const t = w.terminate.bind(w); let done = false; w.terminate = () => { if (!done) { done = true; window.__live--; } t(); };
      if (window.__mode === 'kill') setTimeout(() => { w.terminate(); w.dispatchEvent(new ErrorEvent('error', { message: 'killed by test' })); }, 500);
      return w;
    };
  });
  await page.evaluate(() => { window.__brihaspatiTimeoutMs = 1500; });       // a compile takes ~9 s: it times out
  let o = await runCell(0, 'BrihaspatiTimeout');
  check(o.length === 1 && o[0].ename === 'BrihaspatiTimeout', 'a hung/slow worker ends the cell with ename BrihaspatiTimeout');
  await page.evaluate(() => { window.__brihaspatiTimeoutMs = 120000; window.__mode = 'kill'; });
  o = await runCell(0, 'BrihaspatiWorkerDied');
  check(o.length === 1 && o[0].ename === 'BrihaspatiWorkerDied', 'a killed worker ends the cell with ename BrihaspatiWorkerDied');
  await page.evaluate(() => { window.__mode = 'normal'; });
  o = await runCell(0);
  check(isDeepStrictEqual(project(o), got[cells[0]]), 'after both failures the same cell runs again, same outputs');
  const live = await page.evaluate(() => [window.__live, window.__maxLive]);
  check(live[0] === 0 && live[1] === 1, `no stacked workers: live now ${live[0]}, never more than ${live[1]} at once`);
  await page.screenshot({ path: join(out, 'notebook.png') });
} catch (e) { console.log('FAIL', e.message); bad++; try { await page.screenshot({ path: join(out, 'notebook-fail.png') }); } catch {} }
check(errs.length === 0, `no page errors${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);
await browser.close(); server.close();
process.exit(bad ? 1 : 0);
