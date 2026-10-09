#!/bin/sh
# Regenerate cells/expected.jsonl ONLY from native yantra-run (kernel/native.sh). Never from wasm.
# A cell whose native run prints no JSON row is named and the script exits 1 without replacing expected.jsonl.
set -eu
cd "$(dirname "$0")/.."
: > cells/expected.jsonl.new
failed=""
for f in cells/*.t1; do
  # A named refusal (e.g. CellShapeRefused) exits non-zero but prints its JSON row: that row is expected.
  out=$(sh kernel/native.sh "$f") || true
  if printf '%s' "$out" | python3 -c 'import sys,json; json.loads(sys.stdin.read())' 2>/dev/null; then
    printf '%s' "$out" | python3 -c 'import sys,json; j=json.loads(sys.stdin.read()); j["cell"]=sys.argv[1]; print(json.dumps(j,ensure_ascii=False))' "$(basename "$f")" >> cells/expected.jsonl.new
  else
    failed="$failed $(basename "$f")"
  fi
done
if [ -n "$failed" ]; then
  rm -f cells/expected.jsonl.new
  echo "expect.sh: native run failed for:$failed — expected.jsonl NOT replaced" >&2
  exit 1
fi
mv cells/expected.jsonl.new cells/expected.jsonl
wc -l cells/expected.jsonl
