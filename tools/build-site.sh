#!/bin/sh
# Reproducible build of the static JupyterLite site (site/) carrying the बृहस्पति kernel.
# Needs: python3 -m venv with `pip install jupyterlite-core jupyterlab nodejs-wheel-binaries jupyter-builder`
# (nodejs-wheel-binaries or any Node >= 20 with npm on PATH). vendor/stage1.elf must exist (kernel/fetch-stage1.sh).
set -eu
cd "$(dirname "$0")/.."
test -f vendor/stage1.elf || sh kernel/fetch-stage1.sh
# stamp the extension's source hash into the bundle, so the test can tell a stale bundle
printf "export const SRC_SHA256 = '%s';\n" "$(cat jupyterlite/lib/index.js jupyterlite/lib/refusals.js | sed -e '/^import { SRC_SHA256 }/d' -e '/^export { SRC_SHA256 };$/d' | sha256sum | cut -d' ' -f1)" > jupyterlite/lib/srchash.js
( cd jupyterlite && npm install --no-audit --no-fund && jupyter labextension build . )
python3 tools/make-notebook.py
rm -rf site
jupyter lite build --contents notebooks --output-dir site \
  --FederatedExtensionAddon.extra_labextensions_path="$PWD/jupyterlite/labextensions"
python3 - <<'PY'   # expose the app as window.jupyterapp (the notebook test reads the notebook model)
import json
p = 'site/jupyter-lite.json'; d = json.load(open(p)); d['jupyter-config-data']['exposeAppInBrowser'] = True
json.dump(d, open(p, 'w'), indent=2)
PY
mkdir -p site/brihaspati
cp kernel/core.mjs kernel/pins.json vendor/stage1.elf vendor/yantra_wasm.wasm site/brihaspati/
cp vendor/NOTICE vendor/LICENSE-AGPL-3.0 site/brihaspati/   # the wasm is AGPL-3.0-only
du -sh site
