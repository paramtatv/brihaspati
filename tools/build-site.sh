#!/bin/sh
# Reproducible build of the static JupyterLite site (site/) carrying the बृहस्पति kernel.
# Needs: python3 -m venv with `pip install jupyterlite-core jupyterlab nodejs-wheel-binaries jupyter-builder`
# (nodejs-wheel-binaries or any Node >= 20 with npm on PATH). vendor/stage1.elf must exist (kernel/fetch-stage1.sh).
set -eu
cd "$(dirname "$0")/.."
test -f vendor/stage1.elf || sh kernel/fetch-stage1.sh
( cd jupyterlite && npm install --no-audit --no-fund && jupyter labextension build . )
rm -rf site
jupyter lite build --contents notebooks --output-dir site \
  --FederatedExtensionAddon.extra_labextensions_path="$PWD/jupyterlite/labextensions"
mkdir -p site/brihaspati
cp kernel/core.mjs kernel/pins.json vendor/stage1.elf vendor/yantra_wasm.wasm site/brihaspati/
cp vendor/NOTICE vendor/LICENSE-AGPL-3.0 site/brihaspati/   # the wasm is AGPL-3.0-only
du -sh site
