# Brihaspati kernel

How a cell is compiled, run and compared. Back to the [README](../README.md); the notebook file format is in
[ISAS-FORMAT.md](ISAS-FORMAT.md).

## Overview

A T1 cell is compiled by the self-hosted Sassembly v1.0.2 compiler image running on
yantra-wasm (node), and the emitted program runs on yantra-wasm. The result equals the native run
byte for byte: emitted ELF, output, finisher status, instruction count, guest RAM size and heap high water.

```sh
sh kernel/fetch-stage1.sh                 # compiler image, sha256-pinned (release asset)
node kernel/cell.mjs cells/print_x.t1     # JSON: elf_sha256, status, output, steps_compile, steps_run, ...
sh kernel/native.sh cells/print_x.t1      # same JSON, native yantra-run (needs vendor/yantra-run)
sh test/expect.sh                         # regenerate cells/expected.jsonl, from native ONLY
node test/agree.mjs                       # per cell: native == expected == wasm; non-zero on any disagreement
```

`agree.mjs` first runs a negative control (a flipped field must be reported as a difference), and
refuses an expected row that was not made by the pinned native binary.

## Pins

Everything comes from the PUBLIC repository github.com/paramtatv/sassembly, tag v1.0.2
(commit b86a24ee576f2bd3a0b4e207bb6d724724f132b3). Compiler image: that release's sassembly-v1.0.2-stage1.elf
(kernel/fetch-stage1.sh, plain curl; checked against the release's SHA256SUMS-v1.0.2). vendor/yantra_wasm.wasm is the tag's
crates/yantra-wasm (with the in-memory file root), built at the fixed path /tmp/sassembly (recipe and sha256 in
vendor/NOTICE; two independent clones reproduce it). The native runner is the release's yantra-run (the
sassembly-v1.0.2-linux-x86_64 tarball). All three are sha256-pinned; the drivers refuse on a mismatch.

The pins live in `kernel/pins.json`.

## Cell convention

The v1.0.2 image keeps its default entry unless the input names one (v1.0.2's entry from the input,
not used here yet): it links the corpus into an image whose entry
is one named routine of one named module (both in kernel/pins.json, copied from the compiler source
by script). A cell must use that module and entry; both drivers refuse any other with
`CellShapeRefused` (see cells/entry_not_fixed_refused.t1). The cells are existing integer-semantics,
refusal and array programs from Sassembly tests, module and entry renamed by script, plus derived cells
(print, checked add, a heap over 64 MiB). Refusals are finisher statuses 853 (read past length),
860 (checked overflow), 861 (write at -1), 862 (division by zero).

## Memory

The compiler needs about 640 MiB of guest RAM (512 MiB .bss heap, stack above it); node
holds about 1.4 GB per compile. The wasm run RAM is sized from the emitted ELF by the native rule
(the larger of 20 MiB and the declared extent plus 16 MiB; crates/yantra/src/lib.rs:241,
:245, :318-338), so both engines get the same RAM (`ram_run` is compared). A program that declares
a 512 MiB heap runs in 553,721,872 octets on both; cells/heap_over_64mib.t1 writes 70 MB of it.
wasm32 would refuse a guest RAM above 4 GiB; nothing here is near it.

## The notebook page

`docs/` is the notebook, served at https://paramtatv.github.io/brihaspati and built by
`sh tools/build-docs.sh`: cells of two kinds (code and note), edit, run a cell, run all, add, delete and move cells,
open and save `.isas` files (File API), and a saved-vs-rerun mismatch badge on every code cell. The UI is Sanskrit
first with an en/hi toggle. One worker at a time runs `kernel/core.mjs` (the same file `kernel/cell.mjs` uses). The page
JavaScript is about 48 KB (the .mjs modules; the theme script adds 2.3 KB), without the wasm and the compiler image.

## Refusal names

A refusal is named in Sanskrit, copied from the compiler's `ir.t1` into `kernel/refusals.mjs` by `tools/gen-refusals.py`
(finisher status 853, 860, 861, 862). A driver refusal (`CellShapeRefused`, `StepLimitExceeded`, compile failure) is shown by name.

## Worker failures

A cell runs in one worker at a time; a new run first terminates a live one, so two 640 MiB workers never
stack. A worker that dies is `BrihaspatiWorkerDied`, one that does not answer within 180 s is `BrihaspatiTimeout`
("slow device?"); a run that reaches its 4,000,000,000-step budget is `StepLimitExceeded`; a failed guest-RAM allocation says
how many MiB it wanted. The wasm is AGPL-3.0-only: the page footer links its source (sassembly v1.0.2) and `NOTICE`.
Chromium on a desktop grants the 640 MiB compile memory (about 9 s a cell); a phone browser is untested.

## Known limits

Fixed entry: a cell must be module शृङ्खला with the entry routine named in `kernel/pins.json`
(anything else is `CellShapeRefused`); no state or import between cells. Compile errors carry no source position. Every cell
starts a fresh engine and compiles from scratch, about 70 to 720 million guest steps.

## Live session (in progress)

The persistent-machine interface (`kernel/machine.mjs`, `kernel/session.mjs`: cells linked into a live image, interrupt and resume) is the L28 work. Its yantra-wasm adapter refuses run-after-run and snapshot/restore (`Unsupported`), and the fragment compiler is not built (`FragmentCompilerUnavailable`); no cell runs in a live session yet.

## Tests

`node test/agree.mjs` (native == expected == wasm, 19 cells), `node test/isas.mjs` (round trips incl. an embedded and a side-file image, every refusal, a hostile SVG, the Markdown subset),
`node test/steplimit.mjs`, `PLAYWRIGHT=<playwright-core dir> node test/isas-page.mjs` (headless Chromium: each example opened,
Run all, every result equal to native; save, reopen, a doctored saved output flagged, notes and images from a fixture, a changed image flagged, side-file save and open, worker failures, a live native cell,
page errors fail).

## Licence notes

This repository is AGPL-3.0-only (LICENSE), with a commercial licence available from the copyright holder (COMMERCIAL-LICENSE.md). Commits up to and including e1d80ab were published under MIT and stay MIT as published. Files under their own licences are listed in NOTICE: the vendored `yantra_wasm.wasm` (AGPL-3.0-only, from the crate `crates/yantra-wasm` of Sassembly; corresponding source and build command in `vendor/NOTICE`), the compiler image `stage1.elf` (AGPL-3.0-only, the sassembly v1.0.2 release asset), and the site stylesheet and theme script (MIT). The native `yantra-run` is built from public Sassembly and is not committed here.
