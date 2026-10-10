# बृहस्पति

[![बृहस्पति: the .isas notebook page running a print, a compute cell and a refusal, then a notebook with images](docs/media/brihaspati-demo.gif)](docs/media/brihaspati-demo.mp4)

*A 70-second screen recording of the notebook page opening `.isas` notebooks: a print, a compute cell showing status and steps, a refusal named in Sanskrit, then `images.isas` with a Markdown note and the PNG and SVG its cell wrote. Click for the mp4.*


Phase 1a: a T1 cell is compiled by the self-hosted Sassembly v1.0.2 compiler image running on
yantra-wasm (node), and the emitted program runs on yantra-wasm. The result equals the native run
byte for byte: emitted ELF, output, finisher status, instruction count, guest RAM size and heap high water.

    sh kernel/fetch-stage1.sh                 # compiler image, sha256-pinned (release asset)
    node kernel/cell.mjs cells/print_x.t1     # JSON: elf_sha256, status, output, steps_compile, steps_run, ...
    sh kernel/native.sh cells/print_x.t1      # same JSON, native yantra-run (needs vendor/yantra-run)
    sh test/expect.sh                         # regenerate cells/expected.jsonl, from native ONLY
    node test/agree.mjs                       # per cell: native == expected == wasm; non-zero on any disagreement

`agree.mjs` first runs a negative control (a flipped field must be reported as a difference), and
refuses an expected row that was not made by the pinned native binary.

Pins (kernel/pins.json). Everything comes from the PUBLIC repository github.com/paramtatv/sassembly, tag v1.0.2
(commit b86a24ee576f2bd3a0b4e207bb6d724724f132b3). Compiler image: that release's sassembly-v1.0.2-stage1.elf
(kernel/fetch-stage1.sh, plain curl; checked against the release's SHA256SUMS-v1.0.2). vendor/yantra_wasm.wasm is the tag's
crates/yantra-wasm (with the in-memory file root), built at the fixed path /tmp/sassembly (recipe and sha256 in
vendor/NOTICE; two independent clones reproduce it). The native runner is the release's yantra-run (the
sassembly-v1.0.2-linux-x86_64 tarball). All three are sha256-pinned; the drivers refuse on a mismatch.

Cell convention. The v1.0.2 image keeps its default entry unless the input names one (v1.0.2's entry from the input,
not used here yet): it links the corpus into an image whose entry
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

Licence. This repository is AGPL-3.0-only (LICENSE), with a commercial licence available from the copyright holder (COMMERCIAL-LICENSE.md). Commits up to and including e1d80ab were published under MIT and stay MIT as published. Files under their own licences are listed in NOTICE: the vendored `yantra_wasm.wasm` (AGPL-3.0-only, from the crate `crates/yantra-wasm` of Sassembly; corresponding source and build command in `vendor/NOTICE`), the compiler image `stage1.elf` and the site stylesheet and theme script (MIT, from paramtatv/sassembly). The native `yantra-run` is built from public Sassembly and is not committed here.

The notebook page. `docs/` is the notebook, served at https://paramtatv.github.io/brihaspati and built by
`sh tools/build-docs.sh`: cells of two kinds (code and note), edit, run a cell, run all, add, delete and move cells,
open and save `.isas` files (File API), and a saved-vs-rerun mismatch badge on every code cell. The UI is Sanskrit
first with an en/hi toggle. One worker at a time runs `kernel/core.mjs` (the same file `kernel/cell.mjs` uses). The page
JavaScript is about 48 KB (the .mjs modules; the theme script adds 2.3 KB), without the wasm and the compiler image.

The `.isas` format, version 1 with the amendment (reference parser and writer: `kernel/isas.mjs`; the marker words `कोष्ठः`,
`प्रकारः`, `फलम्` are copied from the format spec into `kernel/isas-names.mjs` by `tools/gen-isas-names.py`). Line 1 is
`ISAS 1`; header lines `key: value` (`title`, `stage1_sha256`, `yantra_wasm_sha256`, `created`; unknown keys are kept); a cell is
a marker line `॥ कोष्ठः N code|note ॥` and its body. A note is a Markdown subset (headings, emphasis, lists, code spans and
blocks, links, tables, images by relative path, quotes, rules) drawn by our own renderer (`kernel/md.mjs`): raw HTML is text,
`javascript:` links are not links, image paths must be relative with no `..`. A code cell may be followed by `॥ फलम् ॥` and
ONE JSON line per output part, each with a MIME `type`: `text/plain {data}`; `image/png` or `image/jpeg`
`{encoding:"base64", data}` or `{src:"<name>.isas.d/<n>.<ext>", sha256}`; `image/svg+xml {data}` (sanitised by `kernel/svg.mjs`: an
allowlist re-serialiser that drops script, foreignObject, style, animation, external references, event attributes, DOCTYPE
and CDATA; applied when a file is read and when an image arrives); and `application/x-sassembly-result {status, steps_compile,
steps_run, refusal}`. There is no `text/html`. Images under 64 KB are embedded; larger ones are written as side files in
`<name>.isas.d/` and referenced by sha256, unless "embed everything" is chosen (the checkbox on the page; without it the browser
downloads the notebook and the side files, which go in a folder `<name>.isas.d/`; open the notebook and its side files together).
A reader refuses by name: `IsasNotAnIsasFile`, `IsasUnknownMajorVersion`, `IsasMalformedHeader`, `IsasBadCellMarker`,
`IsasCellNumberOutOfOrder`, `IsasOutputOnNote`, `IsasBadOutput`, `IsasUnsupportedType`; a missing or changed side file is
`IsasMissingSideFile` or `IsasSideFileHashMismatch`; a .isas over 32 Mi characters or a side file over 16 MiB is `IsasTooLarge`, refused before it is read; the writer refuses `IsasUnwritableBody`, `IsasUnknownCellKind`.
`examples/*.isas` holds the 19 cells as three notebooks (native outputs saved), plus `images.isas` (a rich note and a cell with a
png and an svg output). The output encoding is isolated in `encodeOutput` and `decodeOutput`.

Image channel. Each run gives the program an empty in-memory file root (yantra-wasm's `patra::MemFs`, the same path rules
and refusals as `yantra-run --files`); the files it writes through the patra file window come back as `files: [{name, bytes}]`
and the page types them by magic bytes (PNG, JPEG, sanitised SVG; anything else is ignored). The compiler run has no root.
`test/image-cells/` holds cells that write images, made by `tools/gen-image-cells.mjs`.

A refusal is named in Sanskrit, copied from the compiler's `ir.t1` into `kernel/refusals.mjs` by `tools/gen-refusals.py`
(finisher status 853, 860, 861, 862). A driver refusal (`CellShapeRefused`, `StepLimitExceeded`, compile failure) is shown by name.

Worker failures. A cell runs in one worker at a time; a new run first terminates a live one, so two 640 MiB workers never
stack. A worker that dies is `BrihaspatiWorkerDied`, one that does not answer within 180 s is `BrihaspatiTimeout`
("slow device?"); a run that reaches its 4,000,000,000-step budget is `StepLimitExceeded`; a failed guest-RAM allocation says
how many MiB it wanted. The wasm is AGPL-3.0-only: the page footer links its source (sassembly v1.0.2) and `NOTICE`.
Chromium on a desktop grants the 640 MiB compile memory (about 9 s a cell); a phone browser is untested.

Known limits. Fixed entry: a cell must be module शृङ्खला with the entry routine named in `kernel/pins.json`
(anything else is `CellShapeRefused`); no state or import between cells. Compile errors carry no source position. Every cell
starts a fresh engine and compiles from scratch, about 70 to 720 million guest steps.

Tests. `node test/agree.mjs` (native == expected == wasm, 19 cells), `node test/isas.mjs` (round trips incl. an embedded and a side-file image, every refusal, a hostile SVG, the Markdown subset),
`node test/steplimit.mjs`, `PLAYWRIGHT=<playwright-core dir> node test/isas-page.mjs` (headless Chromium: each example opened,
Run all, every result equal to native; save, reopen, a doctored saved output flagged, notes and images from a fixture, a changed image flagged, side-file save and open, worker failures, a live native cell,
page errors fail).
