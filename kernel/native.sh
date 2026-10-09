#!/bin/sh
# Native counterpart of cell.mjs: same JSON, native yantra-run. usage: kernel/native.sh <cell.t1>
# env: YANTRA_RUN (default vendor/yantra-run; build it, see README), STAGE1 (default vendor/stage1.elf)
exec python3 "$(dirname "$0")/native.py" "$@"
