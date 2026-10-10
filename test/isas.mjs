// SPDX-License-Identifier: AGPL-3.0-only
// .isas format v1 with the amendment: round trips (examples, embedded image, side-file image), every refusal by name,
// SVG sanitising (a hostile SVG), the Markdown subset (no raw HTML), the 64 KB rule.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse, write, resolveSideFiles, IsasError, SIDE_LIMIT, MAX_ISAS, MAX_SIDE } from '../kernel/isas.mjs';
import { BAR, CELL, OUTPUT } from '../kernel/isas-names.mjs';
import { sanitizeSvg } from '../kernel/svg.mjs';
import { mdParse, inline, safeHref, safeRelPath } from '../kernel/md.mjs';
import { sniff, imageParts, b64, RESULT, partBytes } from '../kernel/parts.mjs';
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
process.exit(bad ? 1 : 0);
