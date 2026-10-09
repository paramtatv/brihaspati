// बृहस्पति notebook page: cells, run (one worker at a time), open/save .isas. State is plain data; render() redraws.
import { parse, write, outputOf, stdoutOf, sameOutput, IsasError } from './isas.mjs';
import { LANG, setLang, t } from './i18n.mjs';

const $ = (id) => document.getElementById(id);
const TIMEOUT_MS = 180000;
const nb = { title: '', created: '', extra: [], cells: [], pins: null, assets: null };
let busy = false, live = null, notice = '';
const blank = (kind) => ({ kind, body: '', saved: null, result: null, state: 'idle', detail: '' });

async function loadAssets() {
  const bytes = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(u + ': HTTP ' + r.status); return new Uint8Array(await r.arrayBuffer()); };
  const pins = await (await fetch('vendor/pins.json')).json();
  nb.pins = pins; nb.assets = { stage1: await bytes('vendor/stage1.elf'), wasm: await bytes('vendor/yantra_wasm.wasm') };
}

// ---- one worker at a time; a dead or silent worker ends the cell with a named error -------------------------------
function runInWorker(src) {
  if (live) live.stop(new Error('stopped'));
  const w = new Worker('worker.mjs', { type: 'module' });
  const ms = Number(window.__timeoutMs) || TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let timer;
    const h = { stop(e) { if (live !== h) return; live = null; clearTimeout(timer); w.terminate(); reject(e); } };
    live = h;
    const named = (name, msg) => Object.assign(new Error(msg), { ename: name });
    timer = setTimeout(() => h.stop(named('BrihaspatiTimeout', t('timeout', Math.round(ms / 1000)))), ms);
    w.onmessage = (ev) => { if (live !== h) return; live = null; clearTimeout(timer); w.terminate(); ev.data.ok ? resolve(ev.data.row) : reject(new Error(ev.data.message)); };
    const died = (ev) => h.stop(named('BrihaspatiWorkerDied', 'the worker died (' + ((ev && ev.message) || 'out of memory?') + ')'));
    w.onerror = died; w.onmessageerror = died;
    w.postMessage({ stage1: nb.assets.stage1, wasm: nb.assets.wasm, src, pins: nb.pins });
  });
}
async function runCell(i) {
  const c = nb.cells[i]; if (c.kind !== 'code') return;
  c.state = 'running'; c.detail = ''; render();
  try {
    const row = await runInWorker(c.body.replace(/^\s*\n/, '').replace(/\s+$/, '') + '\n');
    c.result = outputOf(row); c.state = 'done'; c.detail = row.error ? (row.why || row.halt || '') : ''; c.elf = row.elf_sha256 || '';
    if (row.error === 'StepLimitExceeded' || row.error === 'EngineHalt' || row.error === 'RamTooLarge' || row.error === 'compile') c.detail = row.why || JSON.stringify(row);
  } catch (err) { c.result = outputOf({ error: err.ename || 'BrihaspatiError' }); c.state = 'done'; c.detail = String(err.message || err); }
  render();
}
async function guard(fn) { if (busy) return; busy = true; render(); try { await fn(); } finally { busy = false; render(); window.__idle = (window.__idle || 0) + 1; } }

// ---- notebook <-> file ----------------------------------------------------------------------------------------------
function load(text) {
  const p = parse(text);
  const get = (k) => (p.header.find(([x]) => x === k) || [, ''])[1];
  nb.title = get('title'); nb.created = get('created');
  nb.extra = p.header.filter(([k]) => !['title', 'stage1_sha256', 'yantra_wasm_sha256', 'created'].includes(k));
  nb.cells = p.cells.map((c) => ({ ...blank(c.kind), body: c.body, saved: c.output }));
  const pinned = get('stage1_sha256') === nb.pins.stage1_sha256 && get('yantra_wasm_sha256') === nb.pins.yantra_wasm_sha256;
  notice = pinned ? '' : t('pins');
}
function save() {
  const header = [['title', nb.title], ['stage1_sha256', nb.pins.stage1_sha256], ['yantra_wasm_sha256', nb.pins.yantra_wasm_sha256], ['created', nb.created || new Date().toISOString().slice(0, 10)], ...nb.extra];
  const cells = nb.cells.map((c) => ({ kind: c.kind, body: c.body, output: c.kind === 'code' ? (c.result || c.saved) : null }));
  return write({ header, cells });
}
const fail = (e) => { notice = e instanceof IsasError ? `${e.name}: ${e.why}${e.line ? ' (' + e.line + ')' : ''}` : String(e.message || e); render(); };

// ---- view -----------------------------------------------------------------------------------------------------------
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) k.startsWith('on') ? e.addEventListener(k.slice(2), v) : k === 'class' ? (e.className = v) : e.setAttribute(k, v); for (const k of kids) e.append(k); return e; };
const outputView = (c) => {
  const box = el('div', { class: 'out' });
  if (c.state === 'running') { box.append(el('div', { class: 'run' }, t('running'))); return box; }
  const o = c.result; if (!o && !c.saved) return box;
  const show = (out, label) => {
    const d = el('div', { class: 'part' }); if (label) d.append(el('div', { class: 'lab' }, label));
    const text = stdoutOf(out); if (text) d.append(el('pre', { class: 'stdout' }, text));
    if (out.refusal) d.append(el('div', { class: 'err' }, `${out.refusal.name}${out.refusal.code !== null ? " · " + out.refusal.code : ""}`));
    if (out.status !== null) d.append(el('div', { class: 'res' }, `status ${out.status} · steps_compile ${out.steps_compile} · steps_run ${out.steps_run}`));
    return d;
  };
  if (o) box.append(show(o, c.saved ? t('rerun') : ''));
  if (c.saved && o && !sameOutput(c.saved, o)) { box.append(el('div', { class: 'mismatch' }, t('mismatch')), show(c.saved, t('saved'))); }
  else if (c.saved && o) box.append(el('div', { class: 'match' }, t('match')));
  else if (c.saved) box.append(show(c.saved, t('saved')));
  if (c.detail) box.append(el('div', { class: 'detail' }, c.detail));
  return box;
};
function render() {
  $('title').value = nb.title; $('notice').textContent = notice; $('notice').hidden = !notice;
  for (const id of ['runall', 'newnb', 'addcode', 'addnote', 'savenb', 'opennb', 'examples']) $(id).disabled = busy || (id === 'runall' && !nb.cells.length);
  const list = $('cells'); list.replaceChildren();
  nb.cells.forEach((c, i) => {
    const ta = el('textarea', { class: c.kind === 'code' ? 'src' : 'note', spellcheck: 'false', rows: String(Math.max(2, c.body.split('\n').length)), 'aria-label': t(c.kind) });
    ta.value = c.body; ta.addEventListener('input', () => { c.body = ta.value; ta.rows = Math.max(2, ta.value.split('\n').length); });
    const btn = (key, fn, dis = false) => { const b = el('button', { type: 'button', class: 'btn btn--sm', onclick: fn }, t(key)); b.disabled = busy || dis; return b; };
    const bar = el('div', { class: 'cbar' }, el('span', { class: 'num' }, `[${i + 1}] ${t(c.kind)}`),
      ...(c.kind === 'code' ? [btn('run', () => guard(() => runCell(i)))] : []),
      btn('up', () => { [nb.cells[i - 1], nb.cells[i]] = [nb.cells[i], nb.cells[i - 1]]; render(); }, i === 0),
      btn('down', () => { [nb.cells[i + 1], nb.cells[i]] = [nb.cells[i], nb.cells[i + 1]]; render(); }, i === nb.cells.length - 1),
      btn('kind', () => { c.kind = c.kind === 'code' ? 'note' : 'code'; if (c.kind === 'note') { c.saved = c.result = null; } render(); }),
      btn('del', () => { nb.cells.splice(i, 1); render(); }));
    list.append(el('section', { class: 'cell cell--' + c.kind, 'data-i': String(i) }, bar, ta, ...(c.kind === 'code' ? [outputView(c)] : [])));
  });
  $('empty').hidden = nb.cells.length > 0;
  for (const n of document.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
  document.documentElement.lang = LANG();
  window.__nb = nb;
}

// ---- wiring ---------------------------------------------------------------------------------------------------------
$('title').addEventListener('input', () => { nb.title = $('title').value; });
$('addcode').onclick = () => { nb.cells.push(blank('code')); render(); };
$('addnote').onclick = () => { nb.cells.push(blank('note')); render(); };
$('newnb').onclick = () => { Object.assign(nb, { title: '', created: '', extra: [], cells: [blank('code')] }); notice = ''; render(); };
$('runall').onclick = () => guard(async () => { for (let i = 0; i < nb.cells.length; i++) await runCell(i); });
$('opennb').onclick = () => $('file').click();
$('file').onchange = async () => {
  const f = $('file').files[0]; $('file').value = ''; if (!f) return;
  try { load(await f.text()); render(); } catch (e) { fail(e); }
};
$('savenb').onclick = () => {
  try {
    const url = URL.createObjectURL(new Blob([save()], { type: 'text/plain;charset=utf-8' }));
    const a = el('a', { href: url, download: (nb.title || 'notebook').replace(/[^\p{L}\p{N}_-]+/gu, '-') + '.isas' }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) { fail(e); }
};
$('examples').onchange = async () => {
  const f = $('examples').value; $('examples').value = ''; if (!f) return;
  try { const r = await fetch('examples/' + f); if (!r.ok) throw new Error(f + ': HTTP ' + r.status); load(await r.text()); render(); } catch (e) { fail(e); }
};
$('lang').onchange = () => { setLang($('lang').value); render(); };
(async () => {
  $('lang').value = LANG();
  try {
    await loadAssets();
    const idx = await (await fetch('examples/index.json')).json();
    for (const e of idx) $('examples').add(new Option(e.title + ' — ' + e.file, e.file));
    $('examples').value = '';
    if (!nb.cells.length) nb.cells.push(blank('code'));
    window.__ready = true;
  } catch (e) { notice = 'load failed: ' + e.message; }
  render();
})();
