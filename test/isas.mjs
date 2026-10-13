// SPDX-License-Identifier: AGPL-3.0-only
// .isas format v1 with the amendment: round trips (examples, embedded image, side-file image), every refusal by name,
// SVG sanitising (a hostile SVG), the Markdown subset (no raw HTML), the 64 KB rule.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse, write, resolveSideFiles, resolvePlugins, pluginsOf, treeHash, parseLock, formatLock, IsasError, SIDE_LIMIT, MAX_ISAS, MAX_SIDE } from '../kernel/isas.mjs';
import { BAR, CELL, OUTPUT } from '../kernel/isas-names.mjs';
import { sanitizeSvg } from '../kernel/svg.mjs';
import { mdParse, inline, safeHref, safeRelPath } from '../kernel/md.mjs';
import { sniff, imageParts, b64, RESULT, partBytes, sha256hex } from '../kernel/parts.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fx = (f) => new Uint8Array(readFileSync(join(root, 'test/fixtures', f)));
let bad = 0;
const check = (ok, what) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) bad++; };
const refuses = (text, name, what) => { try { parse(text); check(false, `${what}: parsed, expected ${name}`); } catch (e) { check(e instanceof IsasError && e.name === name, `${what}: refused as ${name}${e.name !== name ? ' (got ' + e.name + ')' : ''}`); } };
const R = (extra = '') => `{"type":"${RESULT}","status":0,"steps_compile":1,"steps_run":2,"refusal":null${extra}}`;

// ---- examples -------------------------------------------------------------------------------------------------------
const dir = join(root, 'examples'), files = readdirSync(dir).filter((f) => f.endsWith('.isas')).sort();
let ncell = 0;
for (const f of files) {
  const t = readFileSync(join(dir, f), 'utf8'), nb = parse(t);
  if (f !== 'images.isas') ncell += nb.cells.filter((c) => c.kind === 'code').length;
  const w = await write(nb, { embedAll: true, name: f.replace('.isas', '') });
  check(w.text === t && w.files.size === 0, `${f}: write(parse(file)) is byte-identical`);
  check(JSON.stringify(parse(w.text)) === JSON.stringify(nb), `${f}: parse(write(nb)) equals nb`);
}
check(ncell === 19, `the examples hold all 19 code cells (${ncell}), plus images.isas`);
const img = parse(readFileSync(join(dir, 'images.isas'), 'utf8'));
check(img.cells[1].output.map((p) => p.type).join() === `image/svg+xml,image/png,${RESULT}`, 'images.isas: a typed part per line (svg, png, result: files in name order, कपत्रम् before खपत्रम्)');

// ---- the format -----------------------------------------------------------------------------------------------------
const ok = `ISAS 1\ntitle: t\nfuture_key: x\n${BAR} ${CELL} 1 code ${BAR}\nbody\n${BAR} ${OUTPUT} ${BAR}\n${R()}\n${BAR} ${CELL} 2 note ${BAR}\nhello\n`;
const nb = parse(ok);
check(nb.header.length === 2 && (await write(nb, { embedAll: true })).text === ok, 'an unknown header key is kept and written back');
refuses('', 'IsasNotAnIsasFile', 'empty file');
refuses('hello\n', 'IsasNotAnIsasFile', 'wrong magic');
refuses('ISAS 1 \n', 'IsasNotAnIsasFile', 'magic with trailing space');
refuses('ISAS 2\ntitle: x\n', 'IsasUnknownMajorVersion', 'major version 2');
refuses('ISAS 1\nnot a header\n', 'IsasMalformedHeader', 'header line without a key');
refuses(`ISAS 1\n${BAR} ${CELL} 1 prose ${BAR}\n`, 'IsasBadCellMarker', 'unknown cell kind');
refuses(`ISAS 1\n${BAR} ${CELL} 2 code ${BAR}\n`, 'IsasCellNumberOutOfOrder', 'cell numbered 2 first');
refuses(`ISAS 1\n${BAR} ${CELL} 1 note ${BAR}\n${BAR} ${OUTPUT} ${BAR}\n${R()}\n`, 'IsasOutputOnNote', 'output on a note');
const C = `ISAS 1\n${BAR} ${CELL} 1 code ${BAR}\n${BAR} ${OUTPUT} ${BAR}\n`;
refuses(C, 'IsasBadOutput', 'marker with no part');
refuses(C + 'not json\n', 'IsasBadOutput', 'part that is not JSON');
refuses(C + '{"status":0}\n', 'IsasBadOutput', 'part without a type');
refuses(C + JSON.stringify({ type: 'image/png', encoding: 'base64', data: Buffer.from('not a png at all').toString('base64') }) + '\n', 'IsasBadOutput', 'an embedded png whose bytes are not a PNG');
refuses(C + JSON.stringify({ type: 'image/jpeg', encoding: 'base64', data: Buffer.from(fx('small.png')).toString('base64') }) + '\n', 'IsasBadOutput', 'an embedded part typed jpeg that holds a PNG');
refuses('ISAS 1\n' + 'x'.repeat(MAX_ISAS), 'IsasTooLarge', 'a file over MAX_ISAS characters');
{ const nb = { cells: [{ kind: 'code', output: [{ type: 'image/png', src: 'a.isas.d/1.png', sha256: '0'.repeat(64) }] }] };
  const pr = await resolveSideFiles(nb, new Map([['1.png', new Uint8Array(MAX_SIDE + 1)]]));
  check(pr.length === 1 && pr[0].name === 'IsasTooLarge', 'a side file over MAX_SIDE octets is IsasTooLarge, not hashed'); }
refuses(C + `{"type":"${RESULT}","status":"x","steps_compile":1,"steps_run":2,"refusal":null}\n`, 'IsasBadOutput', 'result with a text status');
refuses(C + '{"type":"text/html","data":"<b>x</b>"}\n', 'IsasUnsupportedType', 'text/html (not in v1)');
refuses(C + '{"type":"image/png","encoding":"base64","data":"!!!"}\n', 'IsasBadOutput', 'png with bad base64');
refuses(C + '{"type":"image/png","src":"../../etc/passwd","sha256":"' + '0'.repeat(64) + '"}\n', 'IsasBadOutput', 'a side-file src that climbs out');
refuses(C + '{"type":"image/png","src":"x.isas.d/1.png"}\n', 'IsasBadOutput', 'a side file without sha256');
refuses(C + '{"type":"image/svg+xml","data":"hello"}\n', 'IsasBadOutput', 'svg that is not an SVG document');
try { await write({ header: [], cells: [{ kind: 'code', body: `a\n${BAR} ${CELL} 9 code ${BAR}`, output: null }] }); check(false, 'unwritable body'); } catch (e) { check(e.name === 'IsasUnwritableBody', 'a body line that reads as a marker is refused on write'); }
try { await write({ header: [], cells: [{ kind: 'prose', body: '', output: null }] }); check(false, 'kind'); } catch (e) { check(e.name === 'IsasUnknownCellKind', 'writing an unknown kind is refused'); }

// ---- SVG sanitising -------------------------------------------------------------------------------------------------
const hostile = new TextDecoder().decode(fx('hostile.svg'));
const clean = sanitizeSvg(hostile);
check(clean !== null && !/script|foreignObject|onload|onclick|onmouseover|javascript|iframe|evil\.example|ENTITY|DOCTYPE|alert|<style|<image|<set|<animate|CDATA|@import/i.test(clean), `hostile SVG comes out clean: ${clean}`);
check(/<circle cx="5"/.test(clean) && /<rect width="3"/.test(clean), 'the harmless shapes of the hostile SVG survive');
check(sanitizeSvg(clean) === clean, 'sanitising is idempotent');
{ const t0 = performance.now(); const s = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg"><rect fill="${'url('.repeat(60000)}"/></svg>`); const ms = performance.now() - t0;
  check(ms < 500 && s !== null && !/url\(/.test(s), `240 KB of url( with no ) is refused in ${Math.round(ms)} ms (linear; it was quadratic, about 18 s)`); }
{ const s = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" fill="u\\72l(http://evil.example/x)" style="fill:red"/></svg>');
  check(s !== null && !/evil|\\|style/.test(s) && /<rect width="1"/.test(s), `a CSS escape in a value (u\\72l) and a style attribute are dropped: ${s}`); }
check(sanitizeSvg('<html><body>x</body></html>') === null && sanitizeSvg('') === null, 'a non-SVG document is refused (null)');
check(sanitizeSvg(new TextDecoder().decode(fx('ok.svg'))).includes('<circle'), 'a plain SVG keeps its shapes and text');
// the same hostile SVG inside a file: sanitised on read, so the page never sees it
const hostileFile = `${C}${JSON.stringify({ type: 'image/svg+xml', data: hostile })}\n`;
check(!/script|onload|foreignObject/i.test(parse(hostileFile).cells[0].output[0].data), 'a hostile SVG inside an .isas file is sanitised when the file is read');

// ---- parts: sniffing, images ----------------------------------------------------------------------------------------
check(sniff(fx('small.png')) === 'image/png' && sniff(fx('small.jpg')) === 'image/jpeg' && sniff(fx('ok.svg')) === 'image/svg+xml' && sniff(new Uint8Array([1, 2, 3, 4])) === null, 'MIME by magic bytes: png, jpeg, svg, unknown');
const written = imageParts([{ name: 'a.png', bytes: fx('small.png') }, { name: 'b.jpg', bytes: fx('small.jpg') }, { name: 'c.svg', bytes: fx('hostile.svg') }, { name: 'd.bin', bytes: new Uint8Array([9, 9, 9, 9]) }]);
check(written.parts.length === 3 && written.ignored.join() === 'd.bin', 'imageParts: png, jpeg, sanitised svg; an unknown file is ignored');
const mk = (output) => ({ header: [['title', 'x']], cells: [{ kind: 'code', body: 'b', output }] });
const res = { type: RESULT, status: 0, steps_compile: 1, steps_run: 2, refusal: null };

// round trip with an EMBEDDED image (under 64 KB)
let w = await write(mk([...written.parts, res]), { name: 'e' });
check(w.files.size === 0 && w.text.includes('"encoding":"base64"'), 'a small image is embedded (no side file)');
let back = parse(w.text);
check(JSON.stringify(back.cells[0].output) === JSON.stringify(parse((await write(back, { name: 'e' })).text).cells[0].output), 'embedded image: write/parse/write is stable');
check(back.cells[0].output[0].data === b64(fx('small.png')), 'embedded image: the bytes come back exactly');

// round trip with a SIDE-FILE image (64 KB or more)
const bigBytes = fx('big.png'); check(bigBytes.length >= SIDE_LIMIT, `fixture big.png is ${bigBytes.length} bytes (>= 64 KB)`);
w = await write(mk([{ type: 'image/png', encoding: 'base64', data: b64(bigBytes) }, res]), { name: 'nb' });
check(w.files.size === 1 && [...w.files.keys()][0] === 'nb.isas.d/1.png' && !w.text.includes('base64'), 'a large image goes to nb.isas.d/1.png and is referenced by src');
back = parse(w.text);
const part = back.cells[0].output[0];
check(part.src === 'nb.isas.d/1.png' && /^[0-9a-f]{64}$/.test(part.sha256), 'the part carries src and sha256');
check((await resolveSideFiles(back, new Map([['1.png', bigBytes]]))).length === 0 && partBytes(part).length === bigBytes.length, 'side file loaded by base name and verified by sha256');
const tampered = bigBytes.slice(); tampered[100] ^= 1;
const probs = await resolveSideFiles(parse(w.text), new Map([['nb.isas.d/1.png', tampered]]));
check(probs.length === 1 && probs[0].name === 'IsasSideFileHashMismatch', 'a changed side file is refused: IsasSideFileHashMismatch');
check((await resolveSideFiles(parse(w.text), new Map())).map((p) => p.name).join() === 'IsasMissingSideFile', 'a missing side file is named: IsasMissingSideFile');
check((await write(back, { name: 'nb' })).text === w.text, 'side-file notebook: write(parse(file)) keeps the reference, byte-identical');
const emb = await write(back, { embedAll: true, name: 'nb' });
check(emb.files.size === 0 && parse(emb.text).cells[0].output[0].data === b64(bigBytes), 'embed everything: the large image is embedded, no side file');
let threw = null; try { await write(parse(w.text), { embedAll: true, name: 'nb' }); } catch (e) { threw = e.name; }
check(threw === 'IsasMissingSideFile', 'embed everything with an unloaded side file is refused (IsasMissingSideFile)');

// ---- Markdown subset ------------------------------------------------------------------------------------------------
const md = mdParse('# T\n\npara **bold** and *em* and `c` [l](https://x.org) ![a](pics/a.png)\n\n- one\n- two\n\n1. a\n2. b\n\n```sa\ncode <b>\n```\n\n| h1 | h2 |\n|---|---|\n| a | b |\n\n> q\n\n---\n\n<script>alert(1)</script> <img src=x onerror=alert(2)>');
const types = md.map((b) => b.t).join();
check(types === 'h,p,ul,ol,pre,table,quote,hr,p', `blocks: ${types}`);
check(md[1].c.map((x) => x.t).join() === 'text,strong,text,em,text,code,text,a,text,img', 'inline: strong, em, code, link, image');
check(md[8].c.every((x) => x.t === 'text') && md[8].c[0].v.includes('<script>') && md[8].c[0].v.includes('<img'), 'raw HTML is plain text, never a node');
check(md[4].v === 'code <b>', 'a code block is verbatim');
check(inline('[x](javascript:alert(1))')[0].t === 'text' && !safeHref('javascript:alert(1)') && !safeHref('data:text/html,x') && safeHref('https://a.b') && safeHref('notes/a.md'), 'a javascript: or data: link is not a link');
check(safeRelPath('pics/a.png') && !safeRelPath('../a.png') && !safeRelPath('/etc/x') && !safeRelPath('http://x/y.png') && !safeRelPath('a\\b.png'), 'image paths: relative only, no .. , no scheme');
// ---- plugin units (amendment) ---------------------------------------------------------------------------------------
{
  const te = new TextEncoder(), SRC = 'मण्डलम् गणित ॥\nसार्वजनिक चरः क ।', H = await sha256hex(te.encode(SRC));
  const man = (o) => JSON.stringify({ name: 'गणित', version: 'v1.2.3', sha256: H, licence: 'MIT', src: 'embedded:1', ...o });
  const nbOf = (hdr, cells = [`${BAR} ${CELL} 1 plugin ${BAR}\n${SRC}\n`]) => `ISAS 1\n${hdr.join('\n')}${hdr.length ? '\n' : ''}${cells.join('\n')}`;
  const E = nbOf([`plugin: ${man({})}`]);
  const prefused = (hdr, name, what, cells) => refuses(nbOf(hdr, cells), name, what);
  // round trip: embedded, byte-identical both ways
  const pn = parse(E);
  check(pn.cells[0].kind === 'plugin' && pn.cells[0].body === SRC, 'a plugin cell parses with its source as the body');
  check((await write(pn, { embedAll: true })).text === E, 'embedded plugin: write(parse(file)) is byte-identical');
  check(JSON.stringify(parse((await write(pn)).text)) === JSON.stringify(pn), 'embedded plugin: parse(write(nb)) equals nb');
  let r = await resolvePlugins(pn, new Map());
  check(r.problems.length === 0 && r.sources.get('गणित').length === te.encode(pn.cells[0].body).length, 'an embedded plugin verifies against its sha256');
  // negative controls: each refusal, by name
  const flipped = nbOf([`plugin: ${man({})}`], [`${BAR} ${CELL} 1 plugin ${BAR}\n${SRC.replace('क', 'ख')}\n`]);
  r = await resolvePlugins(parse(flipped), new Map());
  check(r.problems.length === 1 && r.problems[0].name === 'IsasPluginHashMismatch', 'a flipped source octet is IsasPluginHashMismatch');
  prefused([`plugin: ${man({})}`], 'IsasPluginOutput', 'an output on a plugin cell', [`${BAR} ${CELL} 1 plugin ${BAR}\n${SRC}\n${BAR} ${OUTPUT} ${BAR}\n${R()}`]);
  try { await write({ header: [['plugin', man({})]], cells: [{ kind: 'plugin', body: SRC, output: [res] }] }); check(false, 'plugin output write'); } catch (e) { check(e.name === 'IsasPluginOutput', 'writing an output on a plugin cell is IsasPluginOutput'); }
  prefused([`plugin: ${man({ src: 'embedded:2' })}`], 'IsasPluginMissing', 'embedded:N beyond the cells');
  prefused([`plugin: ${man({})}`], 'IsasPluginMissing', 'embedded:N naming a code cell', [`${BAR} ${CELL} 1 code ${BAR}\nx`]);
  prefused([], 'IsasPluginBadManifest', 'a plugin cell no header names');
  prefused([`plugin: ${man({})}`, `plugin: ${man({ name: 'दूसरा' })}`], 'IsasPluginBadManifest', 'one cell as the source of two plugins');
  const badM = [
    ['not json', 'a manifest that is not JSON'], ['[1]', 'a manifest that is an array'],
    [man({ name: undefined }), 'missing name'], [man({ name: 'a b' }), 'a name with a space'], [man({ name: 'a@b' }), 'a name with @'],
    [man({ version: undefined }), 'missing version'], [man({ version: '1.2.3' }), 'version without v'], [man({ version: 'v१.२.३' }), 'a non-ASCII version'], [man({ version: 'v1.2' }), 'a two-part version'], [man({ version: 'v01.2.3' }), 'a zero-padded version'],
    [man({ sha256: undefined }), 'missing sha256'], [man({ sha256: 'ABC' }), 'a short sha256'], [man({ sha256: H.toUpperCase() }), 'an upper-case sha256'],
    [man({ licence: undefined }), 'missing licence'],
    [man({ src: undefined }), 'missing src'], [man({ src: '/etc/passwd' }), 'an absolute src'], [man({ src: 'https://x.org/a.t1' }), 'a src with a scheme'],
    [man({ src: 'n.isas.d/plugins/../x.t1' }), 'a src that climbs out'], [man({ src: 'n.isas.d/plugins/a\\b.t1' }), 'a src with a backslash'], [man({ src: 'n.isas.d/images/गणित@v1.2.3.t1' }), 'a src outside plugins/'],
    [man({ src: 'n.isas.d/plugins/other@v1.2.3.t1' }), 'a src not named <name>@<version>.t1'], [man({ src: 'embedded:0' }), 'embedded:0'], [man({ src: 'embedded:x' }), 'embedded:x'],
    [man({ path: 'https://github.com/o/r' }), 'a path with a scheme'], [man({ path: 'github.com/o' }), 'a path with too few segments'], [man({ path: 'github.com/o/../r' }), 'a path with ..'], [man({ path: 'o/r/s' }), 'a path whose host has no dot'],
    [man({ path: 'github.com/o/r/v2' }), 'a /v2 path with a v1 version'], [man({ version: 'v2.0.0', path: 'github.com/o/r' }), 'a v2 version without /v2'], [man({ path: 'github.com/o/r/v1' }), 'a /v1 suffix'],
    [man({ requires: 'x' }), 'requires that is not a list'], [man({ requires: ['a', 'a'] }), 'requires with a repeat'], [man({ exports: [1] }), 'exports that are not names'],
    [man({ frag: { src: 'n.isas.d/plugins/f.bin', sha256: H } }), 'frag without stage1_sha256'], [man({ frag: { src: '../f', sha256: H, stage1_sha256: H } }), 'frag with a climbing src'],
    ['lock-line', 'placeholder']
  ].filter(([m]) => m !== 'lock-line');
  for (const [m, what] of badM) refuses(nbOf([`plugin: ${m}`]), 'IsasPluginBadManifest', `bad manifest: ${what}`);
  for (const l of ['MIT-NC', 'CC-BY-NC-4.0', 'GPL-3.0-only', 'Proprietary', 'mit']) refuses(nbOf([`plugin: ${man({ licence: l })}`]), 'IsasPluginLicenceRefused', `licence ${l}`);
  for (const l of ['AGPL-3.0-only', 'MIT', 'BSD-3-Clause', 'Apache-2.0', 'CC0-1.0']) check((() => { try { parse(nbOf([`plugin: ${man({ licence: l })}`])); return true; } catch { return false; } })(), `licence ${l} is accepted`);
  const v2 = man({ version: 'v2.0.0', path: 'github.com/o/r/v2' });
  check((() => { try { parse(nbOf([`plugin: ${v2}`, `lock: github.com/o/r/v2 v2.0.0 h1:${'a'.repeat(64)} MIT ${'b'.repeat(40)}`])); return true; } catch { return false; } })(), 'a /v2 path with a v2 version and a lock line is accepted');
  // unknown fields and unknown header keys are kept
  check((await write(parse(nbOf([`plugin: ${man({ future: 1 })}`, 'x_other: 1'])), { embedAll: true })).text === nbOf([`plugin: ${man({ future: 1 })}`, 'x_other: 1']), 'an unknown manifest field and header key are kept, byte-identical');
  // lock lines
  const L = (o = {}) => ['github.com/o/r', 'v1.0.0', `h1:${'a'.repeat(64)}`, 'MIT', 'b'.repeat(40)].map((x, i) => o[i] ?? x).join(' ');
  for (const [l, n, what] of [[L({ 1: '1.0.0' }), 'IsasPluginBadManifest', 'a lock version without v'], [L({ 2: 'h1:xyz' }), 'IsasPluginBadManifest', 'a short tree hash'], [L({ 2: 'a'.repeat(64) }), 'IsasPluginBadManifest', 'a tree hash without h1:'], [L({ 4: 'abc' }), 'IsasPluginBadManifest', 'a short commit'], [L({ 0: 'https://github.com/o/r' }), 'IsasPluginBadManifest', 'a lock path with a scheme'], [L() + ' extra', 'IsasPluginBadManifest', 'a lock line with six fields'], [L({ 3: 'MIT-NC' }), 'IsasPluginLicenceRefused', 'a lock licence that is NC'], [L({ 3: 'GPL-2.0-only' }), 'IsasPluginLicenceRefused', 'a lock licence off the allowlist']])
    refuses(nbOf([`lock: ${l}`], []), n, `lock: ${what}`);
  check(JSON.stringify(parseLock(formatLock(parseLock(L() + '\n')))) === JSON.stringify(parseLock(L() + '\n')) && formatLock(parseLock(L() + '\n')) === L() + '\n', 'formatLock(parseLock(x)) is byte-identical');
  const withLock = nbOf([`lock: ${L()}`, 'title: t'], [`${BAR} ${CELL} 1 note ${BAR}\nhi\n`]);
  check((await write(parse(withLock), { embedAll: true })).text === withLock, 'lock: header lines round-trip byte-identically');

  // side-file plugin, single unit
  const sf = (o = {}) => nbOf([`plugin: ${man({ src: 'n.isas.d/plugins/गणित@v1.2.3.t1', ...o })}`], []);
  const SP = 'n.isas.d/plugins/गणित@v1.2.3.t1';
  check((await write(parse(sf()))).text === sf() && JSON.stringify(pluginsOf(parse(sf())).plugins.map((p) => p.src)) === JSON.stringify([SP]), 'side-file plugin: header round-trips byte-identically and pluginsOf reads it');
  r = await resolvePlugins(parse(sf()), new Map([[SP, te.encode(SRC)]]));
  check(r.problems.length === 0 && r.sources.size === 1, 'a side-file plugin verifies against its sha256');
  const t2 = te.encode(SRC); t2[3] ^= 1;
  r = await resolvePlugins(parse(sf()), new Map([[SP, t2]]));
  check(r.problems.length === 1 && r.problems[0].name === 'IsasPluginHashMismatch', 'a changed side-file plugin is IsasPluginHashMismatch');
  r = await resolvePlugins(parse(sf()), new Map());
  check(r.problems.length === 1 && r.problems[0].name === 'IsasPluginMissing', 'a missing side-file plugin is IsasPluginMissing');
  r = await resolvePlugins(parse(sf()), new Map([[SP, new Uint8Array(MAX_SIDE + 1)]]));
  check(r.problems.length === 1 && r.problems[0].name === 'IsasTooLarge', 'a side-file plugin over MAX_SIDE is IsasTooLarge, not hashed');

  // packaged plugin: lock + vendored tree
  const tree = new Map([['a.t1', te.encode(SRC)], ['LICENSE', te.encode('MIT\n')], ['plugin.mod', te.encode('path github.com/O/r\n')]]);
  const h1 = await treeHash(tree), D = 'n.isas.d/plugins/github.com/!o/r@v1.2.3/';
  const pk = (o = {}) => nbOf([`plugin: ${man({ path: 'github.com/O/r', sha256: h1, src: D + 'a.t1', ...o })}`], []);
  const vend = (t = tree) => new Map([...t].map(([k, v]) => [D + k, v]));
  const lk = (o = {}) => formatLock([{ path: 'github.com/O/r', version: 'v1.2.3', h1, licence: 'MIT', commit: 'c'.repeat(40), ...o }]);
  check(h1 === await treeHash(new Map([...tree].reverse())), 'treeHash does not depend on entry order');
  { const e = new TextEncoder(), v = new Map([['\uff61', e.encode('a')], ['\u{1F600}', e.encode('b')], ['Z', e.encode('c')]]);   // UTF-8 vs UTF-16 order differ here; vector computed by kernel/isas-pkg.py tree_hash (PLUG-PR)
    check(await treeHash(v) === '57d3aae20dcd495f793dcb9b27413d443d8f228c640ceb511599200e7419a8b6', 'treeHash sorts by UTF-8 bytes: matches the Python resolver on a non-BMP vector'); }
  check(pk().includes('plugins/github.com/!o/r@v1.2.3/a.t1') && (await write(parse(pk()))).text === pk(), 'packaged plugin: header round-trips byte-identically (path escaping !o)');
  const withFileLock = (f) => { const m = vend(); m.set('n.isas.d/plugins.lock', te.encode(f)); return m; };
  r = await resolvePlugins(parse(pk()), withFileLock(lk()), { name: 'n' });
  check(r.problems.length === 0 && r.sources.get('गणित').length === te.encode(SRC).length, 'packaged plugin: vendored tree matches plugins.lock');
  r = await resolvePlugins(parse(nbOf([`plugin: ${man({ path: 'github.com/O/r', sha256: h1, src: D + 'a.t1' })}`, `lock: ${lk().trim()}`], [])), vend());
  check(r.problems.length === 0, 'packaged plugin: lock: header lines serve as the lock');
  const t3 = new Map(tree); t3.set('a.t1', t2);
  r = await resolvePlugins(parse(pk()), (() => { const m = vend(t3); m.set('n.isas.d/plugins.lock', te.encode(lk())); return m; })());
  check(r.problems.length === 1 && r.problems[0].name === 'IsasPluginLockMismatch', 'a changed vendored file is IsasPluginLockMismatch');
  const t4 = new Map(tree); t4.set('extra.t1', te.encode('x'));
  r = await resolvePlugins(parse(pk()), (() => { const m = vend(t4); m.set('n.isas.d/plugins.lock', te.encode(lk())); return m; })());
  check(r.problems.length === 1 && r.problems[0].name === 'IsasPluginLockMismatch', 'an added vendored file is IsasPluginLockMismatch');
  r = await resolvePlugins(parse(pk()), withFileLock(lk({ h1: 'd'.repeat(64) })));
  check(r.problems.length === 1 && r.problems[0].name === 'IsasPluginLockMismatch', 'a lock h1 that differs from the manifest sha256 is IsasPluginLockMismatch');
  r = await resolvePlugins(parse(pk()), withFileLock(lk({ licence: 'Apache-2.0' })));
  check(r.problems.length === 1 && r.problems[0].name === 'IsasPluginLockMismatch', 'a lock licence that differs from the manifest is IsasPluginLockMismatch');
  r = await resolvePlugins(parse(pk()), withFileLock(lk() + lk({ h1: 'e'.repeat(64) })));
  check(r.problems[0]?.name === 'IsasPluginLockMismatch', 'two disagreeing lock entries are IsasPluginLockMismatch');
  r = await resolvePlugins(parse(pk()), vend());
  check(r.problems.length === 1 && r.problems[0].name === 'IsasPluginMissing', 'a package plugin with no lock entry is IsasPluginMissing');
  r = await resolvePlugins(parse(pk()), new Map([['n.isas.d/plugins.lock', te.encode(lk())]]));
  check(r.problems.length === 1 && r.problems[0].name === 'IsasPluginMissing', 'a package plugin with no vendored file is IsasPluginMissing');
  r = await resolvePlugins(parse(pk()), withFileLock(lk({ licence: 'MIT-NC' })));
  check(r.problems.length === 1 && r.problems[0].name === 'IsasPluginBadManifest' || r.problems[0].name === 'IsasPluginLicenceRefused', 'a plugins.lock line with an NC licence is refused by name');
  r = await resolvePlugins(parse(pk()), withFileLock('garbage\n'));
  check(r.problems.length === 1 && r.problems[0].name === 'IsasPluginBadManifest', 'a garbled plugins.lock is IsasPluginBadManifest');
  check(JSON.stringify(parse(nbOf([], [`${BAR} ${CELL} 1 note ${BAR}\nx`])).header) === '[]' && pluginsOf(parse(nbOf([], []))).plugins.length === 0, 'a notebook without plugins reads as before');
}
process.exit(bad ? 1 : 0);
