#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Assemble docs/ (the GitHub Pages site) from the repo's pinned files. Run from anywhere.
set -eu
cd "$(dirname "$0")/.."
mkdir -p docs/assets docs/vendor docs/examples
cp kernel/core.mjs kernel/isas.mjs kernel/isas-names.mjs kernel/refusals.mjs kernel/parts.mjs kernel/svg.mjs kernel/md.mjs docs/
cp vendor/yantra_wasm.wasm vendor/stage1.elf docs/vendor/
cp kernel/pins.json docs/vendor/pins.json
cp vendor/NOTICE vendor/LICENSE-AGPL-3.0 docs/vendor/
cp examples/*.isas examples/index.json docs/examples/
touch docs/.nojekyll
