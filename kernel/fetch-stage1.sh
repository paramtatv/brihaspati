#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Fetch the pinned compiler image (a public release asset, not committed) and verify its sha256.
set -eu
want=4e7a9a244e95bdbf759ba4d373e7efc2e6dcd0e383b9123ac63b5a37d20070ca
dir="$(dirname "$0")/../vendor"
curl -fsSL -o "$dir/stage1.elf" https://github.com/paramtatv/sassembly/releases/download/v1.0.2/sassembly-v1.0.2-stage1.elf
echo "$want  $dir/stage1.elf" | sha256sum -c -
