// .isas format v1: round trips over examples/*.isas, and every refusal by name.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse, write, IsasError } from '../kernel/isas.mjs';
import { BAR, CELL, OUTPUT } from '../kernel/isas-names.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let bad = 0;
const check = (ok, what) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) bad++; };
const refuses = (text, name, what) => { try { parse(text); check(false, `${what}: parsed, expected ${name}`); } catch (e) { check(e instanceof IsasError && e.name === name, `${what}: refused as ${name}${e.name !== name ? ' (got ' + e.name + ')' : ''}`); } };
const dir = join(root, 'examples'), files = readdirSync(dir).filter((f) => f.endsWith('.isas')).sort();
check(files.length >= 2, `${files.length} example notebooks`);
let ncell = 0;
for (const f of files) {
  const t = readFileSync(join(dir, f), 'utf8'), nb = parse(t);
  ncell += nb.cells.filter((c) => c.kind === 'code').length;
  check(write(nb) === t, `${f}: write(parse(file)) is byte-identical`);
  check(JSON.stringify(parse(write(nb))) === JSON.stringify(nb), `${f}: parse(write(nb)) equals nb`);
}
check(ncell === 19, `the examples hold all 19 code cells (${ncell})`);
const ok = `ISAS 1\ntitle: t\nfuture_key: x\n${BAR} ${CELL} 1 code ${BAR}\nbody\n${BAR} ${OUTPUT} ${BAR}\n{"status":0,"steps_compile":1,"steps_run":2,"stdout_b64":"","refusal":null}\n${BAR} ${CELL} 2 note ${BAR}\nhello\n`;
const nb = parse(ok);
check(nb.header.length === 2 && nb.header[1][0] === 'future_key' && write(nb) === ok, 'an unknown header key is kept and written back');
check(nb.cells[1].kind === 'note' && nb.cells[1].body === 'hello' && nb.cells[0].output.steps_run === 2, 'kinds, bodies and the saved output parse');
refuses('', 'IsasNotAnIsasFile', 'empty file');
refuses('hello\n', 'IsasNotAnIsasFile', 'wrong magic');
refuses('ISAS 1 \n', 'IsasNotAnIsasFile', 'magic with trailing space');
refuses('ISAS 2\ntitle: x\n', 'IsasUnknownMajorVersion', 'major version 2');
refuses('ISAS 0\n', 'IsasUnknownMajorVersion', 'major version 0');
refuses('ISAS 1\nnot a header\n', 'IsasMalformedHeader', 'header line without a key');
refuses(`ISAS 1\n${BAR} ${CELL} 1 prose ${BAR}\n`, 'IsasBadCellMarker', 'unknown cell kind');
refuses(`ISAS 1\n${BAR} ${CELL} 2 code ${BAR}\n`, 'IsasCellNumberOutOfOrder', 'cell numbered 2 first');
refuses(`ISAS 1\n${BAR} ${CELL} 1 code ${BAR}\n${BAR} ${CELL} 1 code ${BAR}\n`, 'IsasCellNumberOutOfOrder', 'repeated cell number');
refuses(`ISAS 1\n${BAR} ${CELL} 1 note ${BAR}\n${BAR} ${OUTPUT} ${BAR}\n{}\n`, 'IsasOutputOnNote', 'output on a note');
refuses(`ISAS 1\n${BAR} ${CELL} 1 code ${BAR}\n${BAR} ${OUTPUT} ${BAR}\nnot json\n`, 'IsasBadOutput', 'output that is not JSON');
refuses(`ISAS 1\n${BAR} ${CELL} 1 code ${BAR}\n${BAR} ${OUTPUT} ${BAR}\n{"status":"x","steps_compile":1,"steps_run":2,"stdout_b64":"","refusal":null}\n`, 'IsasBadOutput', 'output with a text status');
refuses(`ISAS 1\n${BAR} ${CELL} 1 code ${BAR}\n${BAR} ${OUTPUT} ${BAR}\n`, 'IsasBadOutput', 'marker with no output line');
refuses(`ISAS 1\n${BAR} ${CELL} 1 code ${BAR}\n${BAR} ${CELL} x code ${BAR}\n`, 'IsasBadCellMarker', 'a line that reads as a marker but is not one');
try { write({ header: [], cells: [{ kind: 'code', body: `a\n${BAR} ${CELL} 9 code ${BAR}`, output: null }] }); check(false, 'unwritable body'); } catch (e) { check(e.name === 'IsasUnwritableBody', 'a body line that reads as a marker is refused on write (IsasUnwritableBody)'); }
try { write({ header: [], cells: [{ kind: 'prose', body: '', output: null }] }); check(false, 'unknown kind'); } catch (e) { check(e.name === 'IsasUnknownCellKind', 'writing an unknown kind is refused (IsasUnknownCellKind)'); }
process.exit(bad ? 1 : 0);
