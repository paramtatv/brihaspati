const $ = (id) => document.getElementById(id);
const FIELDS = ['elf_sha256', 'status', 'output', 'steps_compile', 'steps_run', 'ram_run', 'high_water_run'];
const bytes = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(u + ': HTTP ' + r.status); return new Uint8Array(await r.arrayBuffer()); };
let assets = null;
async function load() {
  if (assets) return assets;
  const pins = await (await fetch('vendor/pins.json')).json();
  const [stage1, wasm] = await Promise.all([bytes('vendor/stage1.elf'), bytes('vendor/yantra_wasm.wasm')]);
  const expected = Object.fromEntries((await (await fetch('cells/expected.jsonl')).text()).split('\n').filter(Boolean).map((l) => { const j = JSON.parse(l); return [j.cell, j]; }));
  return (assets = { pins, stage1, wasm, expected });
}
const show = (v) => v === undefined || v === null ? '' : String(v).length > 22 ? String(v).slice(0, 20) + '…' : String(v);
async function init() {
  const a = await load();
  const sel = $('cell');
  for (const name of Object.keys(a.expected).sort()) sel.add(new Option(name, name));
  sel.value = 'print_x.t1';
  const showSrc = async () => { $('src').textContent = await (await fetch('cells/' + sel.value)).text(); $('result').hidden = true; };
  sel.onchange = showSrc; await showSrc();
  $('run').disabled = false;
  $('run').onclick = async () => {
    $('run').disabled = true; $('status').textContent = $('status').dataset.busy;
    const t0 = performance.now();
    const src = await (await fetch('cells/' + sel.value)).text();
    const w = new Worker('demo-worker.mjs', { type: 'module' });
    w.onmessage = (ev) => {
      w.terminate(); $('run').disabled = false;
      if (!ev.data.ok) { $('status').textContent = 'failed: ' + ev.data.message; window.__demo = { failed: ev.data.message }; return; }
      const got = ev.data.row, want = a.expected[sel.value];
      const keys = got.error ? ['error', 'why'] : FIELDS;
      let all = true, rows = '';
      for (const k of keys) {
        const same = JSON.stringify(got[k] ?? null) === JSON.stringify(want[k] ?? null); if (!same) all = false;
        rows += `<tr><th>${k}</th><td>${show(got[k])}</td><td>${show(want[k])}</td><td class="${same ? 'ok' : 'bad'}">${same ? '=' : '≠'}</td></tr>`;
      }
      $('rows').innerHTML = rows; $('result').hidden = false;
      $('verdict').textContent = (all ? $('verdict').dataset.same : $('verdict').dataset.diff);
      $('status').textContent = ((performance.now() - t0) / 1000).toFixed(1) + ' s';
      window.__demo = { all, got, want };
    };
    w.postMessage({ stage1: a.stage1, wasm: a.wasm, src, pins: a.pins });
  };
}
init().catch((e) => { $('status').textContent = 'load failed: ' + e.message; });
