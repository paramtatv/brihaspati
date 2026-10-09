// Record a ~50 s screen video of the notebook and the docs/ demo page (headless Chromium, 1280x720).
// usage: PLAYWRIGHT=<playwright-core dir> node tools/record-demo.mjs <outdir>   (needs site/ built; serves site/ and docs/ on localhost)
import { readFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2]; mkdirSync(out, { recursive: true });
const { chromium } = await import(pathToFileURL(join(process.env.PLAYWRIGHT, 'index.mjs')).href);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.ipynb': 'application/json', '.elf': 'application/octet-stream', '.woff2': 'font/woff2', '.png': 'image/png' };
const serve = (dir) => createServer((req, res) => {
  const f0 = join(dir, normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  try { const f = existsSync(f0) && !extname(f0) ? join(f0, 'index.html') : f0; const b = readFileSync(f); res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(404); res.end(); }
});
const s1 = serve(join(root, 'site')).listen(0, '127.0.0.1'), s2 = serve(join(root, 'docs')).listen(0, '127.0.0.1');
await new Promise((r) => setTimeout(r, 300));
const P1 = s1.address().port, P2 = s2.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: out, size: { width: 1280, height: 720 } } });
const page = await ctx.newPage();
const KEEP = ['print_x.t1', 'loop_sum.t1', 'checked_add_overflow_refusal.t1'];
await page.goto(`http://localhost:${P1}/lab/index.html?path=demo.ipynb`);
await page.waitForFunction(() => window.jupyterapp?.shell.currentWidget?.model?.cells.length > 0, null, { timeout: 120000 });
await page.evaluate(async () => {   // keep three cells, hide the side panel so the notebook is wide
  const w = window.jupyterapp.shell.currentWidget; await w.sessionContext.ready;
  const keep = ['print_x.t1', 'loop_sum.t1', 'checked_add_overflow_refusal.t1'];
  const sm = w.model.sharedModel;
  for (let i = sm.cells.length - 1; i >= 0; i--) if (!keep.includes(sm.cells[i].metadata.cell)) sm.deleteCell(i);
  for (let t = 0; t < keep.length; t++) {   // order: print, compute, refusal
    const from = [...sm.cells].findIndex((c) => c.metadata.cell === keep[t]);
    if (from !== t) sm.moveCell(from, t);
  }
  await window.jupyterapp.commands.execute('application:toggle-left-area');
});
const run = async (i, until) => {
  await page.evaluate((i) => { window.jupyterapp.shell.currentWidget.content.activeCellIndex = i; }, i);
  await page.waitForTimeout(2500);                                   // let the viewer read the source
  await page.evaluate(() => window.jupyterapp.commands.execute('notebook:run-cell'));
  await page.waitForFunction(([i, u]) => JSON.stringify(window.jupyterapp.shell.currentWidget.model.toJSON().cells[i].outputs).includes(u), [i, until], { timeout: 120000 }).catch(async (e) => { await page.screenshot({ path: join(out, 'fail.png') }); throw e; });
  await page.evaluate(() => window.jupyterapp.shell.currentWidget.content.activeCell.node.querySelector('.jp-OutputArea').scrollIntoView({ block: 'end', behavior: 'smooth' }));
  await page.waitForTimeout(i === 2 ? 5500 : 3500);
};
await page.waitForTimeout(2500);
await run(0, 'execute_result');
await run(1, 'execute_result');
await run(2, 'निषेधः');
await page.waitForTimeout(2000);
// the docs/ demo page, one cell
await page.goto(`http://localhost:${P2}/index.html`);
await page.waitForFunction(() => !document.getElementById('run').disabled, null, { timeout: 60000 });
await page.waitForTimeout(1500);
await page.selectOption('#cell', 'print_xx.t1');
await page.waitForTimeout(1500);
await page.click('#run');
await page.waitForFunction(() => window.__demo, null, { timeout: 120000 });
await page.evaluate(() => document.getElementById('result').scrollIntoView({ block: 'center' }));
await page.waitForTimeout(4000);
const video = page.video();
await ctx.close(); await browser.close(); s1.close(); s2.close();
console.log('video', await video.path());
