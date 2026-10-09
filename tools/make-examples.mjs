// examples/*.isas from cells/*.t1 and the NATIVE rows of cells/expected.jsonl (saved outputs are native's).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { write, outputOf } from '../kernel/isas.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(readFileSync(join(root, 'kernel/pins.json'), 'utf8'));
const rows = Object.fromEntries(readFileSync(join(root, 'cells/expected.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { const j = JSON.parse(l); return [j.cell, j]; }));
const GROUPS = {
  'arithmetic': ['अङ्कगणितम्', 'Integer arithmetic: wrap-around, shifts, comparisons, a loop', ['add_overflow_wraps', 'multiply_wraps', 'shift_left_by_64', 'shift_right_logical_arith', 'unsigned_compare', 'underflow_compare', 'loop_sum', 'many_literals']],
  'arrays-and-output': ['सारण्यः मुद्रणं च', 'Arrays, the heap and printing', ['print_x', 'print_xx', 'callee_grows_parameter', 'octet_store_wide_value', 'heap_over_64mib']],
  'refusals': ['निषेधाः', 'The named refusals, and the fixed-entry refusal', ['checked_add_overflow_refusal', 'division_by_zero_refusal', 'read_of_empty_array_refusal', 'read_past_length_refusal', 'write_at_minus_one_refusal', 'entry_not_fixed_refused']],
};
mkdirSync(join(root, 'examples'), { recursive: true });
const seen = new Set(), index = [];
for (const [file, [title, en, names]] of Object.entries(GROUPS)) {
  const cells = [{ kind: 'note', body: `${title} — ${en}. Saved outputs were made by the native runner.`, output: null }];
  for (const n of names) {
    seen.add(n);
    cells.push({ kind: 'code', body: readFileSync(join(root, 'cells', n + '.t1'), 'utf8').replace(/\n+$/, ''), output: outputOf(rows[n + '.t1']) });
  }
  writeFileSync(join(root, 'examples', file + '.isas'), write({ header: [['title', title], ['stage1_sha256', pins.stage1_sha256], ['yantra_wasm_sha256', pins.yantra_wasm_sha256], ['created', '2026-10-09']], cells }));
  index.push({ file: file + '.isas', title });
}
const all = Object.keys(rows).map((k) => k.replace('.t1', ''));
if (all.some((n) => !seen.has(n)) || seen.size !== all.length) throw new Error('a cell is in no notebook');
writeFileSync(join(root, 'examples/index.json'), JSON.stringify(index, null, 1) + '\n');
