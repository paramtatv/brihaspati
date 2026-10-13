// SPDX-License-Identifier: AGPL-3.0-only
// BR-11 page test (headless Chromium, mock machine injected as window.__brihSpawn): stop mid-cell, resume, re-run N replaces, stale badge, Run all = restart.
// Also: without __brihSpawn the Stop button never shows (default path). usage: PLAYWRIGHT=<playwright-core dir> [CHROME=...] node test/br11-page.mjs
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..'), docs = join(root, 'docs');
const { chromium } = await import(pathToFileURL(join(process.env.PLAYWRIGHT, 'index.mjs')).href);
let bad = 0; const check = (ok, what) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) bad++; };
const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.js': 'text/javascript' };
const server = createServer((req, res) => {
  const pn = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const f0 = pn.startsWith('/__test/') ? join(root, 'test', pn.slice(8)) : pn.startsWith('/kernel/') ? join(root, pn) : join(docs, pn);
  try { const f = existsSync(f0) && !extname(f0) ? join(f0, 'index.html') : f0; const b = readFileSync(f); res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' }); res.end(b); } catch { res.writeHead(404); res.end(); }
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const exe = process.env.CHROME; const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
const errs = [];
const open = async (mock) => {
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage(); page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.waitForFunction(() => window.__ready, null, { timeout: 60000 });
  await page.evaluate(() => localStorage.setItem('brihaspati-lang', 'en')); await page.selectOption('#lang', 'en');
  if (mock) await page.evaluate(async () => {
    const { serveWorker, nextTick } = await import('/kernel/proto.mjs'); const { mockApi, mockCompile } = await import('/__test/mock-machine.mjs');
    window.__api = mockApi();
    window.__brihSpawn = () => {   // the "worker" is a MessageChannel peer
      const ch = new MessageChannel();
      const h = serveWorker({ api: window.__api, compileFragment: async (a) => mockCompile(a), slice: 1000, post: (m) => ch.port2.postMessage(m), tick: () => new Promise((r) => setTimeout(r, 0)) });
      ch.port2.onmessage = (ev) => h(ev.data);
      return { postMessage: (m) => ch.port1.postMessage(m), set onmessage(f) { ch.port1.onmessage = f; }, terminate() { ch.port1.close(); ch.port2.close(); } };
    };
  });
  return page;
};
const setCells = (page, srcs) => page.evaluate((srcs) => { const nb = window.__nb; nb.cells.length = 0; for (const b of srcs) nb.cells.push({ kind: 'code', body: b, saved: null, result: null, state: 'idle', detail: '' }); window.__render(); }, srcs);
const txt = (page, i) => page.locator('.cell').nth(i).innerText();
try {
  // gate, default path: WITHOUT window.__brihSpawn a cell is run by the old runInWorker path: no controller, no live elements, proto.mjs never requested
  { const page = await open(false); const reqs = []; page.on('request', (r) => reqs.push(r.url()));
    await page.click('#addcode'); await setCells(page, ['emit A']);
    const n = await page.evaluate(() => window.__idle || 0);
    await page.locator('.cell').nth(0).getByRole('button', { name: 'Run', exact: true }).click();
    await page.waitForFunction((n) => (window.__idle || 0) > n, n, { timeout: 60000 });
    check(await page.evaluate(() => window.__ctl === undefined) && !reqs.some((u) => /proto\.mjs/.test(u)), 'default path (no capability): a cell Run uses the old path: no controller, proto.mjs not requested');
    check(await page.locator('#stopnb').isHidden() && (await page.locator('.cell .stop').count()) === 0 && (await page.locator('.cell .live').count()) === 0 && (await page.locator('.stale').count()) === 0, 'default path (no capability): no Stop button, no progress, no badge');
    await page.context().close(); }
  // gate, live path (positive control): WITH window.__brihSpawn the same Run goes through the controller
  { const page = await open(true); const reqs = []; page.on('request', (r) => reqs.push(r.url()));
    await setCells(page, ['emit A']);
    const n = await page.evaluate(() => window.__idle || 0);
    await page.locator('.cell').nth(0).getByRole('button', { name: 'Run', exact: true }).click();
    await page.waitForFunction((n) => (window.__idle || 0) > n, n, { timeout: 60000 });
    check(await page.evaluate(() => window.__ctl !== undefined) && reqs.some((u) => /proto\.mjs/.test(u)) && (await txt(page, 0)).includes('A'), 'live path (capability present): a cell Run goes through the controller and the mock machine');
    await page.context().close(); }
  const page = await open(true);
  await setCells(page, ['def x=7\nemit A', 'def y=1\nloop 100000\nemit end', 'need x\nemit x=$x']);
  const run = (i) => page.locator('.cell').nth(i).getByRole('button', { name: 'Run', exact: true }).click();
  const idleN = () => page.evaluate(() => window.__idle || 0);
  const waitIdle = async (n) => page.waitForFunction((n) => (window.__idle || 0) > n, n, { timeout: 20000 });
  let n = await idleN(); await run(0); await waitIdle(n);
  check((await txt(page, 0)).includes('A'), 'cell 1 ran through the mock machine; output shown');
  // stop mid-cell
  n = await idleN(); await run(1);
  await page.waitForFunction(() => /steps: [3-9]\d|steps: \d{3,}/.test(document.querySelectorAll('.cell')[1]?.innerText), null, { timeout: 10000 });
  check(await page.locator('#stopnb').isVisible() && (await page.locator('.cell').nth(1).locator('.stop').count()) === 1, 'running: Stop button and step counter visible');
  await page.locator('.cell').nth(1).locator('.stop').click(); await waitIdle(n);
  const t1 = await txt(page, 1);
  check(/stopped/.test(t1) && /\.{3,}/.test(t1), 'stopped mid-cell: marked stopped, partial output kept');
  check(await page.locator('#stopnb').isHidden(), 'Stop button hidden again when idle');
  // state kept: cell 3 still sees x
  n = await idleN(); await run(2); await waitIdle(n);
  check((await txt(page, 2)).includes('x=7'), 'state kept after Stop: cell 3 reads cell 1 value');
  // resume = re-run the stopped cell; it replaces the interrupted result
  await page.evaluate(() => { window.__nb.cells[1].body = 'def y=1\nloop 5\nemit end'; });
  n = await idleN(); await run(1); await waitIdle(n);
  const t2 = await txt(page, 1); check(t2.includes('.....end') && !/stopped/.test(t2), 'resume: re-running the stopped cell completes and replaces the partial result');
  // re-run N replaces + stale badge
  await page.evaluate(() => { window.__nb.cells[0].body = 'def x=8\nemit A2'; });
  n = await idleN(); await run(0); await waitIdle(n);
  check((await txt(page, 0)).includes('A2') && (await page.locator('.cell').nth(2).locator('.stale').count()) === 1 && (await page.locator('.stale').count()) === 1, 're-run cell 1 replaces its result; stale badge on cell 3 only');
  n = await idleN(); await run(2); await waitIdle(n);
  check((await txt(page, 2)).includes('x=8') && (await page.locator('.stale').count()) === 0, 'cell 3 re-run sees the new value; badge cleared');
  // Run all = restart
  await page.evaluate(() => { window.__nb.cells[0].body = 'def x=9\nemit A3'; });
  n = await idleN(); const r0 = await page.evaluate(() => window.__api.log.resets); await page.click('#runall'); await waitIdle(n);
  check((await page.evaluate(() => window.__api.log.resets)) === r0 + 1 && (await txt(page, 2)).includes('x=9') && (await page.locator('.stale').count()) === 0, 'Run all = machine restart; all cells recomputed; no stale badge');
  await page.context().close();
} catch (e) { console.log('FAIL', e.stack); bad++; }
check(errs.length === 0, `no page errors${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);
await browser.close(); server.close();
console.log(bad ? `FAIL ${bad}` : 'PASS'); process.exit(bad ? 1 : 0);
