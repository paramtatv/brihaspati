# The `.isas` notebook format

Back to the [README](../README.md); the kernel is described in [KERNEL.md](KERNEL.md).

## Format

Version 1 with the amendment (reference parser and writer: `kernel/isas.mjs`; the marker words `कोष्ठः`,
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

## Refusals

A reader refuses by name: `IsasNotAnIsasFile`, `IsasUnknownMajorVersion`, `IsasMalformedHeader`, `IsasBadCellMarker`,
`IsasCellNumberOutOfOrder`, `IsasOutputOnNote`, `IsasBadOutput`, `IsasUnsupportedType`; a missing or changed side file is
`IsasMissingSideFile` or `IsasSideFileHashMismatch`; a .isas over 32 Mi characters or a side file over 16 MiB is `IsasTooLarge`, refused before it is read; the writer refuses `IsasUnwritableBody`, `IsasUnknownCellKind`.

## Examples

`examples/*.isas` holds the 19 cells as three notebooks (native outputs saved), plus `images.isas` (a rich note and a cell with a
png and an svg output). The output encoding is isolated in `encodeOutput` and `decodeOutput`.

## Image channel

Each run gives the program an empty in-memory file root (yantra-wasm's `patra::MemFs`, the same path rules
and refusals as `yantra-run --files`); the files it writes through the patra file window come back as `files: [{name, bytes}]`
and the page types them by magic bytes (PNG, JPEG, sanitised SVG; anything else is ignored). The compiler run has no root.
`test/image-cells/` holds cells that write images, made by `tools/gen-image-cells.mjs`.
