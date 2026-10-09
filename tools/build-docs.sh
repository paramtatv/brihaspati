#!/bin/sh
# Assemble docs/ (the GitHub Pages site) from the repo's pinned files. Run from anywhere.
set -eu
cd "$(dirname "$0")/.."
mkdir -p docs/assets docs/vendor docs/cells
cp kernel/core.mjs docs/core.mjs
cp vendor/yantra_wasm.wasm vendor/stage1.elf docs/vendor/
cp kernel/pins.json docs/vendor/pins.json
cp cells/*.t1 cells/expected.jsonl docs/cells/
touch docs/.nojekyll
