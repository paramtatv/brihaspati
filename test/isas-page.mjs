// Headless Chromium on docs/: open each examples/*.isas through the file input, Run all, and compare every cell's
// result EXACTLY with native (cells/expected.jsonl, plus a native run made during this test); save, and reopen the
// saved file; a doctored saved output is flagged as a mismatch; hung and killed workers end with named errors.
// A page error fails the test.   usage: PLAYWRIGHT=<playwright-core dir> [CHROME=...] node test/isas-page.mjs [outdir]
import { readFileSync, readdirSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse, write, outputOf, resultOf } from '../kernel/isas.mjs';
import { b64 } from '../kernel/parts.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ?? '.'; mkdirSync(out, { recursive: true });
const { chromium } = await import(pathToFileURL(join(process.env.PLAYWRIGHT, 'index.mjs')).href);
let bad = 0;
const check = (ok, what) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) bad++; };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const pins = JSON.parse(readFileSync(join(root, 'kernel/pins.json'), 'utf8'));
const rows = Object.fromEntries(readFileSync(join(root, 'cells/expected.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { const j = JSON.parse(l); return [j.cell, j]; }));
const cellFiles = readdirSync(join(root, 'cells')).filter((f) => f.endsWith('.t1'));
const srcOf = (f) => readFileSync(join(root, 'cells', f), 'utf8').replace(/\n+$/, '');
const bySrc = Object.fromEntries(cellFiles.map((f) => [srcOf(f), f]));
const docs = join(root, 'docs');

// the page under test is the build of THIS source
for (const f of ['core.mjs', 'isas.mjs', 'isas-names.mjs', 'refusals.mjs', 'parts.mjs', 'svg.mjs', 'md.mjs']) check(sha(readFileSync(join(docs, f))) === sha(readFileSync(join(root, 'kernel', f))), `docs/${f} == kernel/${f}`);
check(sha(readFileSync(join(docs, 'vendor/stage1.elf'))) === pins.stage1_sha256 && sha(readFileSync(join(docs, 'vendor/yantra_wasm.wasm'))) === pins.yantra_wasm_sha256, 'docs/vendor assets == pins');
const examples = readdirSync(join(root, 'examples')).filter((f) => f.endsWith('.isas') && f !== 'images.isas').sort();
const fixture = (f) => ({ name: f, b64: readFileSync(join(root, 'test/fixtures', f)).toString('base64') });
for (const f of [...examples, 'images.isas']) check(sha(readFileSync(join(docs, 'examples', f))) === sha(readFileSync(join(root, 'examples', f))), `docs/examples/${f} == examples/${f}`);
if (bad) process.exit(1);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.isas': 'text/plain' };
const server = createServer((req, res) => {
  const f0 = join(docs, normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  try { const f = existsSync(f0) && !extname(f0) ? join(f0, 'index.html') : f0; const b = readFileSync(f); res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' }); res.end(b); } catch { res.writeHead(404); res.end(); }
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
await page.waitForFunction(() => window.__ready, null, { timeout: 60000 });
const idle = () => page.evaluate(() => window.__idle || 0);
const runAll = async () => { const n = await idle(); await page.click('#runall'); await page.waitForFunction((n) => (window.__idle || 0) > n, n, { timeout: 900000 }); };
const model = () => page.evaluate(() => window.__nb.cells.map((c) => ({ kind: c.kind, body: c.body, saved: c.saved, result: c.result, detail: c.detail })));
const wantOut = (f) => outputOf(rows[f], []);
let savedText = null;

try {
  for (const ex of examples) {
    await page.setInputFiles('#file', join(root, 'examples', ex));
    await page.waitForFunction((n) => window.__nb.cells.length === n, parse(readFileSync(join(root, 'examples', ex), 'utf8')).cells.length);
    await runAll();
    const cells = await model();
    let n = 0, allSame = true;
    for (const c of cells) if (c.kind === 'code') { n++; const f = bySrc[c.body]; if (!f || !isDeepStrictEqual(c.result, wantOut(f))) { allSame = false; console.log('   differs:', f, JSON.stringify(c.result), JSON.stringify(wantOut(f))); } }
    check(allSame, `${ex}: run all, ${n} code cells, every result EXACTLY equals native's (status, steps, stdout, refusal name and code)`);
    check(cells.filter((c) => c.kind === 'code').every((c) => isDeepStrictEqual(c.result, c.saved)), `${ex}: no saved-vs-rerun mismatch`);
    check(await page.locator('.mismatch').count() === 0, `${ex}: the page shows no mismatch badge`);
    if (ex === 'refusals.isas') {
      await page.screenshot({ path: join(out, 'isas-page.png'), fullPage: false });
      const txt = await page.locator('#cells').innerText();
      check(['रिक्तखण्डपठननिषेधः', 'अतिप्रवाहनिषेधः', 'सीमातीतलेखननिषेधः', 'शून्यविभाजननिषेधः', 'CellShapeRefused'].every((w) => txt.includes(w)), 'refusals.isas: the Sanskrit refusal names and CellShapeRefused are on the page');
    }
  }
  // ---- rich notes, images (from a FIXTURE: the worker's file channel is a stub), mismatch on a changed image ----
  await page.setInputFiles('#file', join(root, 'examples/images.isas'));
  await page.waitForFunction(() => window.__nb.cells.length === 2);
  const md = page.locator('.cell--note .md').first();
  check(await md.locator('h2').count() === 1 && await md.locator('table th').count() === 2 && await md.locator('ul li').count() === 3 && await md.locator('strong').count() === 1 && await md.locator('a[href^="https://"]').count() === 1, 'note: heading, table, list, bold and a link are rendered');
  check(await md.locator('b').count() === 0 && (await md.innerText()).includes('<b>this</b>'), 'note: raw HTML in a note is shown as text, not run');
  await page.click('#addnote');
  await page.locator('.cell textarea').last().fill('<script>window.__pwned=1</script><img src=x onerror="window.__pwned=2"> [x](javascript:window.__pwned=3)');
  check(await page.locator('.cell--note').last().locator('script, img, a').count() === 0 && await page.evaluate(() => window.__pwned === undefined), 'note: script, img onerror and javascript: links in a note do nothing');
  check(await page.locator('.cell--code .pic').count() === 2, 'images.isas: the saved png and svg are shown as images');
  await page.evaluate((f) => { window.__fixtureFiles = f; }, [fixture('small.png'), fixture('ok.svg')]);
  await page.locator('.cell--code').first().locator('button').first().click();
  await page.waitForFunction(() => window.__nb.cells[1].result);
  check(await page.locator('.mismatch').count() === 0 && await page.locator('.match').count() === 1, 'the rerun with the same images equals the saved output (no mismatch)');
  await page.evaluate((f) => { window.__fixtureFiles = f; }, [fixture('other.png'), fixture('ok.svg')]);
  await page.locator('.cell--code').first().locator('button').first().click();
  await page.waitForFunction(() => window.__nb.cells[1].result.some((p) => p.type === 'image/png' && p.data !== window.__nb.cells[1].saved.find((q) => q.type === 'image/png').data));
  check(await page.locator('.mismatch').count() === 1, 'a changed image shows the mismatch badge');
  await page.evaluate((f) => { window.__fixtureFiles = f; }, [fixture('hostile.svg')]);
  await page.locator('.cell--code').first().locator('button').first().click();
  await page.waitForFunction(() => window.__nb.cells[1].result.some((p) => p.type === 'image/svg+xml' && !window.__nb.cells[1].result.some((q) => q.type === 'image/png')));
  const svgPart = (await model())[1].result.find((p) => p.type === 'image/svg+xml');
  check(!/script|foreignObject|onload|javascript|iframe|evil\.example/i.test(svgPart.data) && await page.evaluate(() => window.__pwned === undefined), 'a hostile SVG from the program is sanitised and does nothing');
  // a large image goes to a side file; embed-everything embeds it; reopen with and without the side file
  await page.evaluate((f) => { window.__fixtureFiles = f; }, [fixture('big.png')]);
  await page.locator('.cell--code').first().locator('button').first().click();
  await page.waitForFunction(() => window.__nb.cells[1].result.some((p) => p.type === 'image/png' && p.data.length > 80000));
  await page.fill('#title', 'big-test');
  const dls = []; page.on('download', (d) => dls.push(d));
  await page.click('#savenb'); await page.waitForFunction(() => document.getElementById('notice').textContent.includes('big-test.isas.d'), null, { timeout: 20000 });
  await page.waitForTimeout(500);
  const names = dls.map((d) => d.suggestedFilename()).sort();
  check(names.join() === '1.png,big-test.isas', `save without embed-everything: the notebook and one side file (${names.join()})`);
  const nbPath = join(out, 'big-test.isas'), sidePath = join(out, '1.png');
  for (const d of dls) await d.saveAs(d.suggestedFilename().endsWith('.isas') ? nbPath : sidePath);
  const bigText = readFileSync(nbPath, 'utf8');
  check(bigText.includes('"src":"big-test.isas.d/1.png"') && !bigText.includes('"encoding":"base64"' + ',"data":"iVBOR') && sha(readFileSync(sidePath)) === sha(readFileSync(join(root, 'test/fixtures/big.png'))), 'the .isas references big-test.isas.d/1.png by src and sha256, and the side file is the image');
  await page.setInputFiles('#file', [nbPath, sidePath]);
  await page.waitForFunction(() => window.__nb.cells.length === 3);
  check(await page.locator('.cell--code .pic').count() === 1 && await page.evaluate(() => document.getElementById('notice').textContent === ''), 'open with the side file: the image shows and nothing is reported');
  await page.setInputFiles('#file', nbPath);
  await page.waitForFunction(() => document.getElementById('notice').textContent.includes('IsasMissingSideFile'));
  check(true, 'open without the side file: IsasMissingSideFile is reported');
  writeFileSync(join(out, '1-bad.png'), Buffer.concat([readFileSync(sidePath).subarray(0, 100), Buffer.from([1]), readFileSync(sidePath).subarray(101)]));
  mkdirSync(join(out, 'bad'), { recursive: true }); writeFileSync(join(out, 'bad/1.png'), readFileSync(join(out, '1-bad.png')));
  await page.setInputFiles('#file', [nbPath, join(out, 'bad/1.png')]);
  await page.waitForFunction(() => document.getElementById('notice').textContent.includes('IsasSideFileHashMismatch'));
  check(true, 'open with a changed side file: IsasSideFileHashMismatch is reported');
  await page.setInputFiles('#file', [nbPath, sidePath]);
  await page.waitForFunction(() => window.__nb.cells.length === 3 && !document.getElementById('notice').textContent);
  await page.check('#embedall'); dls.length = 0;
  await page.click('#savenb'); await page.waitForTimeout(1500);
  check(dls.length === 1 && dls[0].suggestedFilename() === 'big-test.isas', 'embed everything: one file, no side file');
  await dls[0].saveAs(join(out, 'embedded.isas'));
  check(readFileSync(join(out, 'embedded.isas'), 'utf8').includes('"encoding":"base64"'), 'embed everything: the large image is inside the notebook');
  await page.uncheck('#embedall'); await page.evaluate(() => { window.__fixtureFiles = []; });
  await page.setInputFiles('#file', join(root, 'examples/arrays-and-output.isas')); await page.waitForFunction(() => window.__nb.cells.length === 6); await runAll();
  // edit + structure: add a note, move it up, delete the first cell; then SAVE and compare with the model
  await page.click('#addnote');
  await page.locator('.cell textarea').last().fill('a new note\nsecond line');
  await page.locator('.cell').last().locator('button', { hasText: /↑|ऊर्ध्वम्/ }).first().click();
  const before = (await model()).length;
  await page.locator('.cell').first().locator('button').filter({ hasText: /लोपय/ }).click();
  check((await model()).length === before - 1, 'delete removes a cell');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#savenb')]);
  const p = join(out, 'saved.isas'); await dl.saveAs(p); savedText = readFileSync(p, 'utf8');
  const m = await model(), parsed = parse(savedText);
  check(isDeepStrictEqual(parsed.cells.map((c) => [c.kind, c.body, c.output]), m.map((c) => [c.kind, c.body, c.kind === 'code' ? (c.result || c.saved) : null])), 'save: the downloaded file parses to exactly the page model (kinds, bodies, outputs)');
  check((await write(parsed, { embedAll: true })).text === savedText, 'save: the downloaded file is canonical (write(parse(file)) is byte-identical)');
  check(parsed.cells.some((c) => c.kind === 'note' && c.body === 'a new note\nsecond line'), 'save: the edited note is in the file');
  // reopen the saved file: the cells and saved outputs come back
  await page.setInputFiles('#file', p);
  await page.waitForFunction((n) => window.__nb.cells.length === n, parsed.cells.length);
  const re = await model();
  check(isDeepStrictEqual(re.map((c) => [c.kind, c.body, c.saved]), parsed.cells.map((c) => [c.kind, c.body, c.output])), 'open: the saved file reopens to the same cells and saved outputs');
  // a doctored saved output is flagged
  const doctored = readFileSync(join(root, 'examples/arrays-and-output.isas'), 'utf8').replace('"steps_run":44', '"steps_run":45');
  check(doctored !== readFileSync(join(root, 'examples/arrays-and-output.isas'), 'utf8'), 'the doctoring changed one saved steps_run');
  const dp = join(out, 'doctored.isas'); writeFileSync(dp, doctored);
  await page.setInputFiles('#file', dp); await page.waitForFunction(() => window.__nb.cells.length > 1);
  await runAll();
  check(await page.locator('.mismatch').count() === 1, 'a doctored saved output shows exactly one mismatch badge after Run all');
  // malformed and unknown-version files are refused by name, shown on the page
  writeFileSync(join(out, 'v2.isas'), 'ISAS 2\ntitle: x\n');
  await page.setInputFiles('#file', join(out, 'v2.isas'));
  await page.waitForFunction(() => document.getElementById('notice').textContent.includes('IsasUnknownMajorVersion'));
  check(true, 'ISAS 2 is refused on the page as IsasUnknownMajorVersion');
  // worker failures
  await page.setInputFiles('#file', join(root, 'examples/arrays-and-output.isas'));
  await page.waitForFunction(() => window.__nb.cells.length > 1);
  await page.evaluate(() => {
    const W = window.Worker; window.__live = 0; window.__maxLive = 0; window.__mode = 'normal';
    window.Worker = function (...a) { const w = new W(...a); window.__live++; window.__maxLive = Math.max(window.__maxLive, window.__live);
      const t = w.terminate.bind(w); let done = false; w.terminate = () => { if (!done) { done = true; window.__live--; } t(); };
      if (window.__mode === 'kill') setTimeout(() => { w.terminate(); w.dispatchEvent(new ErrorEvent('error', { message: 'killed by test' })); }, 500);
      return w; };
    window.__timeoutMs = 1500;
  });
  const runOne = async () => { const n = await idle(); await page.locator('.cell--code').first().locator('button').first().click(); await page.waitForFunction((n) => (window.__idle || 0) > n, n, { timeout: 120000 }); return (await model()).find((c) => c.kind === 'code').result; };
  let r = await runOne();
  check(resultOf(r)?.refusal?.name === 'BrihaspatiTimeout', 'a slow worker ends the cell with BrihaspatiTimeout');
  await page.evaluate(() => { window.__timeoutMs = 120000; window.__mode = 'kill'; });
  r = await runOne();
  check(resultOf(r)?.refusal?.name === 'BrihaspatiWorkerDied', 'a killed worker ends the cell with BrihaspatiWorkerDied');
  await page.evaluate(() => { window.__mode = 'normal'; });
  r = await runOne();
  check(isDeepStrictEqual(r, wantOut('print_x.t1')), 'after both failures the cell runs again, equal to native');
  const live = await page.evaluate(() => [window.__live, window.__maxLive]);
  check(live[0] === 0 && live[1] === 1, `no stacked workers (live ${live[0]}, max ${live[1]})`);
  // one cell run NATIVELY now
  const nat = JSON.parse(execFileSync('sh', [join(root, 'kernel/native.sh'), join(root, 'cells/print_x.t1')], { encoding: 'utf8' }));
  check(isDeepStrictEqual(r, outputOf(nat)), 'print_x: the page equals a native run made during this test');
  // language toggle
  await page.selectOption('#lang', 'en');
  check((await page.locator('#runall').innerText()) === 'Run all', 'the en toggle switches the UI');
} catch (e) { console.log('FAIL', e.message); bad++; try { await page.screenshot({ path: join(out, 'isas-fail.png') }); } catch {} }
check(errs.length === 0, `no page errors${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);
await browser.close(); server.close();
process.exit(bad ? 1 : 0);
