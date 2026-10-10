#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""बृहस्पति phase 1a, native side: compile ONE T1 cell with the Stage 1 image on native yantra-run,
run the emitted ELF on native yantra-run, print JSON.  The wasm twin is kernel/cell.mjs.

Usage: kernel/native.py <cell.t1> [--elf-out FILE]
Env:   STAGE1 (image), YANTRA_RUN (binary)
"""
import hashlib, json, os, re, subprocess, sys, tempfile, time

RUN_STEPS = 4_000_000_000   # as the wasm driver
src_path = sys.argv[1]
elf_out = sys.argv[sys.argv.index("--elf-out") + 1] if "--elf-out" in sys.argv else None
here = os.path.dirname(os.path.abspath(__file__))
stage1 = os.environ.get("STAGE1", os.path.join(here, "..", "vendor", "stage1.elf"))
yrun = os.environ.get("YANTRA_RUN", os.path.join(here, "..", "vendor", "yantra-run"))

pins = json.load(open(os.path.join(here, "pins.json")))
for path, key in ((stage1, "stage1_sha256"), (yrun, "yantra_run_sha256")):
    got = hashlib.sha256(open(path, "rb").read()).hexdigest()
    if got != pins[key]:
        print(json.dumps({"error": "PinMismatch", "what": key, "got": got}))
        sys.exit(4)

src = open(src_path, "rb").read()
first = src.split(b"\n", 1)[0].decode().split()
entry_decl = "सार्वजनिक वृत्तिः %s ददाति" % pins["entry"]
if first[:2] != [first[0], pins["module"]] or entry_decl not in src.decode():
    print(json.dumps({"engine": "native", "yantra_run_sha256": pins["yantra_run_sha256"], "stage1_sha256": pins["stage1_sha256"], "error": "CellShapeRefused",
                      "why": "a cell must be module %s with entry routine %s (the v1.0.1 image has a fixed entry)"
                             % (pins["module"], pins["entry"])}, ensure_ascii=False))
    sys.exit(3)
name = first[1]                      # the module name, derived as pack-corpus.py derives it
blob = name.encode() + b"\0" + src + b"\0"


def steps_of(err):
    return int(re.search(r"^steps: (\d+)", err, re.M).group(1))


def status_of(err):
    m = re.search(r"^halt: Finisher \{ value: \d+, status: (Some\((\d+)\)|None) \}", err, re.M)
    if m:
        return int(m.group(2)) if m.group(2) is not None else None
    m = re.search(r"^halt: StepLimit", err, re.M)
    return "halt:5" if m else "halt:other"


with tempfile.TemporaryDirectory() as d:
    bp = os.path.join(d, "cell.blob")
    open(bp, "wb").write(blob)
    env = dict(os.environ, YANTRA_INPUT=bp, YANTRA_INPUT_NAME=name,
               YANTRA_RAM=str(2684354560), YANTRA_STEPS="4000000000000")
    t0 = time.time()
    c = subprocess.run([yrun, stage1], env=env, capture_output=True)
    wall = time.time() - t0
    cerr = c.stderr.decode()
    sink = c.stdout
    off = sink.find(b"\x7fELF")
    st = status_of(cerr)
    if off < 0 or st != 1200:
        print(json.dumps({"error": "compile", "compile_status": st}))
        sys.exit(2)
    elf = sink[off:len(sink) - 1]
    if elf_out:
        open(elf_out, "wb").write(elf)
    ep = os.path.join(d, "cell.elf")
    open(ep, "wb").write(elf)
    env2 = {k: v for k, v in os.environ.items() if not k.startswith("YANTRA_")}
    env2.update(YANTRA_STEPS=str(RUN_STEPS), YANTRA_WATERMARK="1")   # RAM: the runner sizes it, ram_for (Span::Declared)
    r = subprocess.run([yrun, ep], env=env2, capture_output=True)
    rerr = r.stderr.decode()
    print(json.dumps({
        "engine": "native", "yantra_run_sha256": pins["yantra_run_sha256"], "stage1_sha256": pins["stage1_sha256"],
        "elf_sha256": hashlib.sha256(elf).hexdigest(),
        "status": status_of(rerr),
        "output": r.stdout.decode("utf-8", "replace"),
        "output_hex": r.stdout.hex(),
        "steps_compile": steps_of(cerr),
        "steps_run": steps_of(rerr),
        "ram_run": int(re.search(r"^ram: high water \d+ of (\d+)", rerr, re.M).group(1)),
        "high_water_run": int(re.search(r"^ram: high water (\d+) of", rerr, re.M).group(1)),
        "wall_compile_s": round(wall, 3),
    }, ensure_ascii=False))
