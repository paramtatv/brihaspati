// Record a ~55 s screen video of the notebook page (headless Chromium, 1280x720); localhost only.
// usage: PLAYWRIGHT=<playwright-core dir> node tools/record-demo.mjs <outdir>   (serves docs/)
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..'), docs = join(root, 'docs');
const out = process.argv[2]; mkdirSync(out, { recursive: true });
const { chromium } = await import(pathToFileURL(join(process.env.PLAYWRIGHT, 'index.mjs')).href);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.isas': 'text/plain' };
const server = createServer((req, res) => {
  const f0 = join(docs, normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  try { const f = existsSync(f0) && !extname(f0) ? join(f0, 'index.html') : f0; const b = readFileSync(f); res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' }); res.end(b); } catch { res.writeHead(404); res.end(); }
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: out, size: { width: 1280, height: 720 } } });
const page = await ctx.newPage();
await page.goto(`http://localhost:${server.address().port}/index.html`);
await page.waitForFunction(() => window.__ready, null, { timeout: 60000 });
await page.waitForTimeout(2500);
const pick = async (file, nth, label) => {
  await page.selectOption('#examples', file);
  await page.waitForFunction((t) => window.__nb.title.length > 0, null);
  await page.waitForTimeout(2000);
  const cell = page.locator('.cell--code').nth(nth);
  await cell.scrollIntoViewIfNeeded(); await page.waitForTimeout(2000);
  const n = await page.evaluate(() => window.__idle || 0);
  await cell.locator('button').first().click();
  await page.waitForFunction((n) => (window.__idle || 0) > n, n, { timeout: 120000 });
  await cell.evaluate((e) => e.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  await page.waitForTimeout(4500);
};
await pick('arrays-and-output.isas', 0);   // print_x
await pick('arithmetic.isas', 6);          // loop_sum: status and steps
await pick('refusals.isas', 0);            // checked add: the Sanskrit refusal name
await page.selectOption('#lang', 'en'); await page.waitForTimeout(2500);
await page.selectOption('#lang', 'sa'); await page.waitForTimeout(1500);
const v = page.video(); await ctx.close(); await browser.close(); server.close();
console.log('video', await v.path());
