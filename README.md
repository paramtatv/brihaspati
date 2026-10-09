# बृहस्पति

Phase 1a: a T1 cell is compiled by the self-hosted Sassembly v1.0.1 compiler image running on
yantra-wasm (node), and the emitted program runs on yantra-wasm. The result equals the native run
byte for byte: emitted ELF, output, finisher status, instruction count, guest RAM size and heap high water.

    sh kernel/fetch-stage1.sh                 # compiler image, sha256-pinned (release asset)
    node kernel/cell.mjs cells/print_x.t1     # JSON: elf_sha256, status, output, steps_compile, steps_run, ...
    sh kernel/native.sh cells/print_x.t1      # same JSON, native yantra-run (needs vendor/yantra-run)
    sh test/expect.sh                         # regenerate cells/expected.jsonl, from native ONLY
    node test/agree.mjs                       # per cell: native == expected == wasm; non-zero on any disagreement

`agree.mjs` first runs a negative control (a flipped field must be reported as a difference), and
refuses an expected row that was not made by the pinned native binary.

Pins (kernel/pins.json). Everything comes from the PUBLIC repository github.com/paramtatv/sassembly, tag v1.0.1
(commit 831e4f0b5f285cefd27d09968e01c5b2fe290afa). Compiler image: that release's
sassembly-v1.0.1-stage1.elf (kernel/fetch-stage1.sh, plain curl). vendor/yantra_wasm.wasm is
`cargo +1.94.0 build --release --locked --target wasm32-unknown-unknown` in crates/yantra-wasm of the tag; the native runner is
`cargo +1.94.0 build --release --locked -p yantra --bin yantra-run`; both built with
`RUSTFLAGS=--remap-path-prefix=<checkout>=/sassembly --remap-path-prefix=$HOME/.cargo=/cargo --remap-path-prefix=$HOME/.rustup=/rustup`
(no local path is embedded). All three are sha256-pinned; the drivers refuse on a mismatch.

Cell convention. The v1.0.1 image has a fixed entry: it links the corpus into an image whose entry
is one named routine of one named module (both in kernel/pins.json, copied from the compiler source
by script). A cell must use that module and entry; both drivers refuse any other with
`CellShapeRefused` (see cells/entry_not_fixed_refused.t1). The cells are existing integer-semantics,
refusal and array programs from Sassembly tests, module and entry renamed by script, plus derived cells
(print, checked add, a heap over 64 MiB). Refusals are finisher statuses 853 (read past length),
860 (checked overflow), 861 (write at -1), 862 (division by zero).

Memory. The compiler needs about 640 MiB of guest RAM (512 MiB .bss heap, stack above it); node
holds about 1.4 GB per compile. The wasm run RAM is sized from the emitted ELF by the native rule
(the larger of 20 MiB and the declared extent plus 16 MiB; crates/yantra/src/lib.rs:241,
:245, :318-338), so both engines get the same RAM (`ram_run` is compared). A program that declares
a 512 MiB heap runs in 553,721,872 octets on both; cells/heap_over_64mib.t1 writes 70 MB of it.
wasm32 would refuse a guest RAM above 4 GiB; nothing here is near it.

Licence. This repository is MIT (LICENSE), except the vendored `yantra_wasm.wasm` (in `vendor/` and `docs/vendor/`), which is AGPL-3.0-only like its source crate `crates/yantra-wasm` in the public paramtatv/sassembly v1.0.1. See `vendor/NOTICE` for the corresponding source and build command, and `vendor/LICENSE-AGPL-3.0` for the text. The native `yantra-run` is built from the same public tag and is not committed here.

Phase 1b: the JupyterLite kernel. `jupyterlite/` is a JupyterLite kernel extension (plain JS, no kernel
logic of its own): display name बृहस्पति, kernelspec name `brihaspati`. `execute_request` runs `kernel/core.mjs`
(the same file `kernel/cell.mjs` uses) in a module Web Worker: stdout stream with the cell's output, then an
`execute_result` (`application/json` and `text/plain`) holding `status`, `steps_compile`, `steps_run`. A refusal
(finisher status 853, 860, 861, 862; their Sanskrit names are copied from the compiler's ir.t1 into `jupyterlite/lib/refusals.js` by `tools/gen-refusals.py`) or a driver
refusal (`CellShapeRefused`, compile failure) comes back as an `error` with `ename` = the name and `evalue` = the code
(or the reason).

    sh tools/build-site.sh                       # static site in site/ (git-ignored); venv needs jupyterlite-core, jupyterlab, jupyter-builder, node/npm
    PLAYWRIGHT=<playwright-core dir> node test/notebook.mjs   # headless Chromium: 3 cells == cells/expected.jsonl

The site is about 70 MB (the JupyterLab application; the kernel assets, `site/brihaspati/`, are 1.1 MB). It carries no
Pyodide: बृहस्पति is its only kernel. Browser memory: the compile asks the guest for 640 MiB of wasm memory; Chromium
153 (headless, desktop) grants it, compiling a cell in about 9 s in a worker, and the test and `test/site.py` run it
on every cell shown. A phone browser may refuse a 640 MiB `WebAssembly.Memory`; that is untested.

Worker failures. A cell runs in one worker at a time; a new run first terminates a live one, so two 640 MiB
workers never stack. A worker that dies is reported as `BrihaspatiWorkerDied`, one that does not answer within
180 s as `BrihaspatiTimeout`; a run that reaches its 4,000,000,000-step budget is `StepLimitExceeded`; a failed
guest-RAM allocation says how many MiB it wanted. Restarting the kernel terminates its worker. JupyterLite's
interrupt never reaches the kernel, so interrupting a running cell ends it only through the timeout.
The wasm is AGPL-3.0-only: the kernel's banner and Help links, and the page footer of the demo, point to its
source (sassembly v1.0.1) and to `NOTICE`.

Known limits of phase 1b.
- Fixed entry: a cell must be module शृङ्खला with the entry routine named in `kernel/pins.json` (the v1.0.1 image links
  one fixed entry); anything else is `CellShapeRefused`. There is no multi-cell state and no cell-to-cell import.
- Compile errors carry no source position: a compile failure is reported as `compile` with the engine's status and halt text.
- Per-cell cost: every cell starts a fresh engine and compiles from scratch, about 70 to 720 million guest steps
  (about 9 s on a desktop Chromium; the 640 MiB compile memory is allocated and released per cell).

Tests. `node test/agree.mjs` (native == expected == wasm, 19 cells), `node test/steplimit.mjs`,
`PLAYWRIGHT=... node test/notebook.mjs` (all 19 cells in the notebook with exact output equality, two cells run
natively during the test, the site checked against this source by hash, page errors fail, killed and hung workers).
