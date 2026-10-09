// Headless Chromium: open the JupyterLite site's demo notebook, run 3 cells (print, compute, refusal) with the
// बृहस्पति kernel, and assert each cell's outputs equal native's (cells/expected.jsonl).
// usage: PLAYWRIGHT=<dir of playwright-core, e.g. the python package's driver/package> \
//        [CHROME=/usr/bin/google-chrome] node test/notebook.mjs [outdir]
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ?? '.';
mkdirSync(out, { recursive: true });
const { chromium } = await import(pathToFileURL(join(process.env.PLAYWRIGHT, 'index.mjs')).href);
const expected = Object.fromEntries(readFileSync(join(root, 'cells/expected.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { const j = JSON.parse(l); return [j.cell, j]; }));
import { REFUSALS } from '../jupyterlite/lib/refusals.js';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.ipynb': 'application/json', '.elf': 'application/octet-stream', '.map': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png' };
const site = join(root, 'site');
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(site, normalize(p));
  try { if (existsSync(f) && !extname(f)) f = join(f, 'index.html'); const b = readFileSync(f); res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(404); res.end(); }
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}/lab/index.html?path=demo.ipynb`;

const cells = ['print_x.t1', 'loop_sum.t1', 'checked_add_overflow_refusal.t1'];
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
let bad = 0;
const check = (ok, what) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) bad++; };
try {
  await page.goto(url);
  await page.waitForSelector('.jp-Notebook .jp-Cell', { timeout: 120000 });
  await page.waitForTimeout(3000);
  for (let i = 0; i < cells.length; i++) {
    const cell = page.locator('.jp-Notebook .jp-Cell').nth(i);
    await cell.locator('.jp-InputArea-editor').click();
    await page.keyboard.press('Shift+Enter');
    await page.waitForFunction((n) => { const c = document.querySelectorAll('.jp-Notebook .jp-Cell')[n]; const p = c.querySelector('.jp-InputPrompt'); return p && /\[\d+\]/.test(p.textContent) && c.querySelector('.jp-OutputArea-child'); }, i, { timeout: 300000 });
    const want = expected[cells[i]];
    // the stream, then the execute_result (or the error) are separate output children; wait for the last one
    const last = REFUSALS[want.status] ? 'निषेधः' : 'steps_run';
    await page.waitForFunction(([n, re]) => new RegExp(re).test(document.querySelectorAll('.jp-Notebook .jp-Cell')[n].querySelector('.jp-OutputArea').innerText), [i, last], { timeout: 60000 });
    const text = await cell.locator('.jp-OutputArea').innerText();
    console.log(`--- ${cells[i]}\n${text}`);
    if (REFUSALS[want.status]) {
      check(text.includes(REFUSALS[want.status]) && text.includes(String(want.status)), `${cells[i]}: error ${REFUSALS[want.status]} code ${want.status}`);
    } else {
      // the execute_result renders as a JSON tree: "status7 / steps_compile73268228 / steps_run44"
      const m = text.match(/status\s*(\d+)[\s\S]*?steps_compile\s*(\d+)[\s\S]*?steps_run\s*(\d+)/);
      check(!!m && +m[1] === want.status && +m[2] === want.steps_compile && +m[3] === want.steps_run, `${cells[i]}: status/steps_compile/steps_run == native (${want.status}/${want.steps_compile}/${want.steps_run})`);
      check(want.output === '' || text.includes(want.output), `${cells[i]}: stream output ${JSON.stringify(want.output)} == native`);
    }
  }
  await page.screenshot({ path: join(out, 'notebook.png'), fullPage: false });
} catch (e) { console.log('FAIL', e.message); bad++; try { await page.screenshot({ path: join(out, 'notebook-fail.png') }); } catch {} }
if (errs.length) console.log('page errors:', errs.slice(0, 3));
await browser.close(); server.close();
process.exit(bad ? 1 : 0);
