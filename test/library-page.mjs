// SPDX-License-Identifier: AGPL-3.0-only
// Headless Chromium on docs/: the notebook sidebar. Three notebooks, switching, highlight, rename, delete, persistence over reload,
// a page whose localStorage throws, phone width, and no network request beyond the page's own origin and its two font hosts.
// usage: PLAYWRIGHT=<playwright-core dir> [CHROME=...] node test/library-page.mjs [outdir]    (outdir gets library-page.png)
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..'), docs = join(root, 'docs');
const out = process.argv[2] ?? '.'; mkdirSync(out, { recursive: true });
const { chromium } = await import(pathToFileURL(join(process.env.PLAYWRIGHT, 'index.mjs')).href);
let bad = 0;
const check = (ok, what) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) bad++; };
const sha = (b) => createHash('sha256').update(b).digest('hex');
check(sha(readFileSync(join(docs, 'library.mjs'))) === sha(readFileSync(join(root, 'kernel/library.mjs'))), 'docs/library.mjs == kernel/library.mjs');
if (bad) process.exit(1);

const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.isas': 'text/plain' };
const server = createServer((req, res) => {
  const f0 = join(docs, normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  try { const f = existsSync(f0) && !extname(f0) ? join(f0, 'index.html') : f0; const b = readFileSync(f); res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' }); res.end(b); } catch { res.writeHead(404); res.end(); }
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}/index.html`;
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', headless: true });
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];   // already on the page before this change
const remote = new Set();
async function open(opts = {}, init) {
  const ctx = opts.ctx ?? await browser.newContext({ viewport: { width: opts.w ?? 1280, height: 900 } });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
  await page.route('**/*', (r) => { const u = new URL(r.request().url()); if (u.hostname !== '127.0.0.1') { remote.add(u.href); return r.abort(); } return r.continue(); });
  await page.goto(url); await page.waitForFunction(() => window.__ready, null, { timeout: 60000 });
  return { ctx, page, errs };
}
const names = (p) => p.$$eval('#nblist li .nm, #nblist li input', (n) => n.map((x) => x.textContent || x.value));
const cur = (p) => p.$$eval('#nblist li.cur .nm', (n) => n.map((x) => x.textContent));
const setCell = async (p, text) => { await p.fill('.cell textarea >> nth=0', text); };
const settle = (p) => p.evaluate(() => window.__flush());

{
  const { ctx, page, errs } = await open();
  check((await names(page)).length === 1 && (await cur(page)).length === 1, 'first visit: one notebook, highlighted');
  await page.fill('#title', 'first'); await setCell(page, 'AAA'); await settle(page);
  await page.click('#newnb'); await page.waitForFunction(() => window.__lib.list().length === 2);
  await page.fill('#title', 'second'); await setCell(page, 'BBB'); await settle(page);
  await page.click('#newnb'); await page.waitForFunction(() => window.__lib.list().length === 3);
  await page.fill('#title', 'third'); await setCell(page, 'CCC'); await settle(page);
  check((await names(page)).join() === 'third,second,first' && (await cur(page)).join() === 'third', 'three notebooks listed newest first; "third" highlighted');
  await page.screenshot({ path: join(out, 'library-page.png') });
  await page.click('#nblist li:has-text("first") .pick');
  await page.waitForFunction(() => window.__nb.title === 'first');
  check((await page.inputValue('.cell textarea >> nth=0')) === 'AAA' && (await cur(page)).join() === 'first' && (await page.inputValue('#title')) === 'first', 'click switches: the text and title of "first" come back, it is highlighted');
  check(await page.getAttribute('#nblist li.cur', 'aria-current') === 'true', 'the current row carries aria-current');
  // rename (inline, Enter)
  await page.click('#nblist li:has-text("second") .act >> nth=0'); await page.fill('#nblist input', 'renamed'); await page.press('#nblist input', 'Enter');
  check((await names(page)).includes('renamed') && !(await names(page)).includes('second'), 'rename: Enter commits');
  await page.click('#nblist li:has-text("renamed") .act >> nth=0'); await page.fill('#nblist input', 'first'); await page.press('#nblist input', 'Enter');
  check((await names(page)).includes('first (2)'), 'rename onto an existing title becomes "first (2)"');
  await page.click('#nblist li:has-text("first (2)") .act >> nth=0'); await page.fill('#nblist input', 'zzz'); await page.press('#nblist input', 'Escape');
  check((await names(page)).includes('first (2)') && !(await names(page)).includes('zzz'), 'rename: Escape cancels');
  await page.click('#nblist li:has-text("first (2)") .act >> nth=0'); await page.fill('#nblist input', 'second'); await page.press('#nblist input', 'Enter');
  // open (file input) -> a NEW entry, never overwriting the current one
  await page.setInputFiles('#file', { name: 'imp.isas', mimeType: 'text/plain', buffer: Buffer.from(await page.evaluate(async () => (await import('./isas.mjs')).write({ header: [['title', 'imported']], cells: [{ kind: 'code', body: 'DDD', output: null }] }, { embedAll: true }).then((r) => r.text))) });
  await page.waitForFunction(() => window.__nb.title === 'imported');
  check((await names(page)).length === 4 && (await cur(page)).join() === 'imported', 'open file: imported as a fourth entry and made current');
  await page.setInputFiles('#file', { name: 'junk.isas', mimeType: 'text/plain', buffer: Buffer.from('not a notebook') });
  await page.waitForFunction(() => document.getElementById('notice').textContent.length > 0);
  check((await names(page)).length === 4 && (await cur(page)).join() === 'imported' && (await page.inputValue('.cell textarea >> nth=0')) === 'DDD', 'a broken file: list and current notebook untouched, error shown');
  // persistence over reload
  await settle(page); await page.reload(); await page.waitForFunction(() => window.__ready);
  check((await names(page)).length === 4 && (await cur(page)).join() === 'imported' && (await page.inputValue('.cell textarea >> nth=0')) === 'DDD', 'reload: the same four notebooks, the same current one with its text');
  // delete (dialog)
  page.once('dialog', (d) => d.dismiss());
  await page.click('#nblist li:has-text("imported") .act >> nth=1');
  check((await names(page)).length === 4, 'delete: cancelling the confirm keeps it');
  page.once('dialog', (d) => d.accept());
  await page.click('#nblist li:has-text("imported") .act >> nth=1');
  await page.waitForFunction(() => window.__lib.list().length === 3 && window.__nb.title !== 'imported');
  check((await cur(page)).length === 1 && !(await names(page)).includes('imported'), 'delete the current: it goes, another one becomes current');
  for (const n of ['third', 'second', 'first']) { page.once('dialog', (d) => d.accept()); await page.click(`#nblist li:has-text("${n}") .act >> nth=1`); await page.waitForFunction((n) => !window.__lib.list().some((r) => r.title === n), n); }
  check((await names(page)).length === 1 && (await cur(page)).length === 1 && (await page.locator('.cell').count()) === 1, 'deleting the last one leaves a fresh blank notebook');
  check(await page.evaluate(() => window.__lib.list().length === 1 && localStorage.length >= 2), 'the browser storage holds the index and the body');
  check(errs.length === 0, 'no page error' + (errs.length ? ': ' + errs[0] : ''));
  await ctx.close();
}
// storage that throws on every access
{
  const { ctx, page, errs } = await open({}, () => { const boom = () => { throw new DOMException('denied', 'SecurityError'); }; Object.defineProperty(window, 'localStorage', { get: boom }); });
  await page.fill('#title', 'volatile'); await page.fill('.cell textarea >> nth=0', 'XYZ'); await page.click('#newnb'); await page.waitForFunction(() => window.__lib.list().length === 2);
  check(!(await page.evaluate(() => window.__lib.persistent)) && (await page.textContent('#snote')).length > 0 && await page.isVisible('#snote'), 'storage throws: page loads, runs on memory, the sidebar says it is not saved');
  await page.click('#nblist li:has-text("volatile") .pick');
  await page.waitForFunction(() => window.__nb.title === 'volatile');
  check((await page.inputValue('.cell textarea >> nth=0')) === 'XYZ', 'storage throws: switching between notebooks still works');
  check(errs.length === 0, 'storage throws: no page error' + (errs.length ? ': ' + errs[0] : ''));
  await ctx.close();
}
// corrupt data already in storage
{
  const { ctx, page, errs } = await open({}, () => { try { if (!localStorage.getItem('seeded')) { localStorage.setItem('seeded', '1'); localStorage.setItem('brih.lib.v1.index', '{broken'); } } catch {} });
  check(await page.evaluate(() => window.__lib.list().length === 1 && localStorage.getItem('brih.lib.v1.index.bad') === '{broken'), 'corrupt index: the page starts with one fresh notebook and keeps the bad copy');
  check(errs.length === 0, 'corrupt index: no page error');
  await ctx.close();
}
// phone width
{
  const { ctx, page } = await open({ w: 390 });
  check(!(await page.isVisible('#side')) && (await page.getAttribute('#sidetoggle', 'aria-expanded')) === 'false', 'phone width: the sidebar starts collapsed');
  await page.click('#sidetoggle');
  check(await page.isVisible('#side') && (await page.getAttribute('#sidetoggle', 'aria-expanded')) === 'true', 'phone width: the toggle opens it');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone width: no horizontal page scroll');
  await page.screenshot({ path: join(out, 'library-page-390.png') });
  await page.click('#sidetoggle'); check(!(await page.isVisible('#side')), 'phone width: the toggle closes it');
  await ctx.close();
}
// no new network
{
  const bodies = ['app.mjs', 'library.mjs', 'i18n.mjs', 'index.html'].map((f) => readFileSync(join(docs, f), 'utf8')).join('\n');
  check(!/\bfetch\(\s*['"`]https?:/.test(bodies) && !/import\(\s*['"`]https?:/.test(bodies) && !/from\s+['"]https?:/.test(bodies) && !/XMLHttpRequest|WebSocket|sendBeacon|EventSource/.test(readFileSync(join(docs, 'library.mjs'), 'utf8')), 'no remote fetch/import and no network API in the library module');
  check([...remote].every((u) => FONT_HOSTS.includes(new URL(u).hostname)), 'every non-local request of the page was to a font host that was already there: ' + ([...remote].map((u) => new URL(u).hostname).filter((v, i, a) => a.indexOf(v) === i).join(', ') || 'none'));
}
await browser.close(); server.close();
console.log(bad ? `${bad} FAILED` : 'all ok'); process.exit(bad ? 1 : 0);
