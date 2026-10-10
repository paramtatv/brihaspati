#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Fetch the pinned compiler image (a public release asset, not committed) and verify its sha256.
set -eu
want=71d06d6649a861c1c6205c95a59fd362f48914b377c6ace9e612bef827415480
dir="$(dirname "$0")/../vendor"
curl -fsSL -o "$dir/stage1.elf" https://github.com/paramtatv/sassembly/releases/download/v1.0.1/sassembly-v1.0.1-stage1.elf
echo "$want  $dir/stage1.elf" | sha256sum -c -
