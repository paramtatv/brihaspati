// SPDX-License-Identifier: AGPL-3.0-only
// बृहस्पति notebook page: cells, run (one worker at a time), open/save .isas. State is plain data; render() redraws.
import { parse, write, resolveSideFiles, MAX_ISAS, MAX_SIDE, outputOf, textOf, resultOf, sameOutput, IsasError } from './isas.mjs';
import { partBytes, imageParts } from './parts.mjs';
import { mdParse, safeHref, safeRelPath } from './md.mjs';
import { LANG, setLang, t } from './i18n.mjs';

const $ = (id) => document.getElementById(id);
const TIMEOUT_MS = 180000;
const nb = { title: '', created: '', extra: [], cells: [], pins: null, assets: null, side: new Map() };
const urls = [];   // object URLs of the current render
const blobUrl = (bytes, type) => { const u = URL.createObjectURL(new Blob([bytes], { type })); urls.push(u); return u; };
let busy = false, live = null, notice = '';
const blank = (kind) => ({ kind, body: '', saved: null, result: null, state: 'idle', detail: '' });

async function loadAssets() {
  const bytes = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(u + ': HTTP ' + r.status); return new Uint8Array(await r.arrayBuffer()); };
  const pins = await (await fetch('vendor/pins.json')).json();
  nb.pins = pins; nb.assets = { stage1: await bytes('vendor/stage1.elf'), wasm: await bytes('vendor/yantra_wasm.wasm') };
}

// ---- one worker at a time; a dead or silent worker ends the cell with a named error ----
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
    c.result = outputOf(row, row.files || []); c.state = 'done'; c.detail = row.error ? (row.why || row.halt || '') : ''; c.elf = row.elf_sha256 || '';
    if (row.error === 'StepLimitExceeded' || row.error === 'EngineHalt' || row.error === 'RamTooLarge' || row.error === 'compile') c.detail = row.why || JSON.stringify(row);
  } catch (err) { c.result = outputOf({ error: err.ename || 'BrihaspatiError' }, []); c.state = 'done'; c.detail = String(err.message || err); }
  render();
}
async function guard(fn) { if (busy) return; busy = true; render(); try { await fn(); } finally { busy = false; render(); window.__idle = (window.__idle || 0) + 1; } }

// ---- notebook <-> file ----
async function load(text, side = new Map()) {
  const p = parse(text);
  const problems = await resolveSideFiles(p, side);
  const get = (k) => (p.header.find(([x]) => x === k) || [, ''])[1];
  nb.title = get('title'); nb.created = get('created');
  nb.extra = p.header.filter(([k]) => !['title', 'stage1_sha256', 'yantra_wasm_sha256', 'created'].includes(k));
  nb.cells = p.cells.map((c) => ({ ...blank(c.kind), body: c.body, saved: c.output }));
  const pinned = get('stage1_sha256') === nb.pins.stage1_sha256 && get('yantra_wasm_sha256') === nb.pins.yantra_wasm_sha256;
  notice = [pinned ? '' : t('pins'), ...problems.map((x) => `${x.name}: ${x.src}`)].filter(Boolean).join(' · ');
  nb.side = side;
}
async function save(embedAll) {
  const header = [['title', nb.title], ['stage1_sha256', nb.pins.stage1_sha256], ['yantra_wasm_sha256', nb.pins.yantra_wasm_sha256], ['created', nb.created || new Date().toISOString().slice(0, 10)], ...nb.extra];
  const cells = nb.cells.map((c) => ({ kind: c.kind, body: c.body, output: c.kind === 'code' ? (c.result || c.saved) : null }));
  return write({ header, cells }, { embedAll, name: (nb.title || 'notebook').replace(/[^\p{L}\p{N}_-]+/gu, '-') });
}
const fail = (e) => { notice = e instanceof IsasError ? `${e.name}: ${e.why}${e.line ? ' (' + e.line + ')' : ''}` : String(e.message || e); render(); };

// ---- view ----
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) k.startsWith('on') ? e.addEventListener(k.slice(2), v) : k === 'class' ? (e.className = v) : e.setAttribute(k, v); for (const k of kids) e.append(k); return e; };
const showParts = (parts, label) => {
  const d = el('div', { class: 'part' }); if (label) d.append(el('div', { class: 'lab' }, label));
  for (const p of parts) {
    if (p.type === 'text/plain') { if (p.data) d.append(el('pre', { class: 'stdout' }, p.data)); }
    else if (p.type.startsWith('image/')) {
      const bytes = partBytes(p);
      if (bytes) d.append(el('img', { class: 'pic', alt: p.type, src: blobUrl(bytes, p.type) }));   // an <img>: SVG shown this way cannot run script
      else d.append(el('div', { class: 'err' }, `${p.problem || 'IsasMissingSideFile'}: ${p.src}`));
    } else {
      if (p.refusal) d.append(el('div', { class: 'err' }, `${p.refusal.name}${p.refusal.code !== null ? ' · ' + p.refusal.code : ''}`));
      if (p.status !== null) d.append(el('div', { class: 'res' }, `status ${p.status} · steps_compile ${p.steps_compile} · steps_run ${p.steps_run}`));
    }
  }
  return d;
};
const outputView = (c) => {
  const box = el('div', { class: 'out' });
  if (c.state === 'running') { box.append(el('div', { class: 'run' }, t('running'))); return box; }
  const o = c.result; if (!o && !c.saved) return box;
  if (o) box.append(showParts(o, c.saved ? t('rerun') : ''));
  if (c.saved && o && !sameOutput(c.saved, o)) { box.append(el('div', { class: 'mismatch' }, t('mismatch')), showParts(c.saved, t('saved'))); }
  else if (c.saved && o) box.append(el('div', { class: 'match' }, t('match')));
  else if (c.saved) box.append(showParts(c.saved, t('saved')));
  if (c.detail) box.append(el('div', { class: 'detail' }, c.detail));
  return box;
};
// Markdown tree -> DOM; text only via textContent, so no raw HTML can ever become markup
const inl = (nodes) => nodes.map((n) => {
  switch (n.t) {
    case 'text': return document.createTextNode(n.v);
    case 'em': return el('em', {}, ...inl(n.c));
    case 'strong': return el('strong', {}, ...inl(n.c));
    case 'code': return el('code', {}, n.v);
    case 'a': return safeHref(n.href) ? el('a', { href: n.href, rel: 'noopener noreferrer', target: '_blank' }, ...inl(n.c)) : document.createTextNode(n.href);
    case 'img': {
      const f = safeRelPath(n.src) ? (nb.side.get(n.src) || nb.side.get(n.src.split('/').pop())) : null;
      return f ? el('img', { class: 'pic', alt: n.alt, src: blobUrl(f, 'image/' + (/\.svg$/i.test(n.src) ? 'svg+xml' : /\.jpe?g$/i.test(n.src) ? 'jpeg' : 'png')) }) : el('span', { class: 'detail' }, `[${n.alt || n.src}]`);
    }
  }
});
const blk = (b) => {
  switch (b.t) {
    case 'h': return el('h' + Math.min(6, b.n + 1), {}, ...inl(b.c));
    case 'p': return el('p', {}, ...inl(b.c));
    case 'ul': case 'ol': return el(b.t, {}, ...b.items.map((it) => el('li', {}, ...inl(it))));
    case 'pre': return el('pre', { class: 'stdout' }, b.v);
    case 'quote': return el('blockquote', {}, ...b.c.map(blk));
    case 'hr': return el('hr');
    case 'table': return el('table', { class: 'cmp' }, el('thead', {}, el('tr', {}, ...b.head.map((h) => el('th', {}, ...inl(h))))), el('tbody', {}, ...b.rows.map((r) => el('tr', {}, ...r.map((x) => el('td', {}, ...inl(x)))))));
  }
};
function render() {
  $('title').value = nb.title; $('notice').textContent = notice; $('notice').hidden = !notice;
  for (const id of ['embedall', 'runall', 'newnb', 'addcode', 'addnote', 'savenb', 'opennb', 'examples']) $(id).disabled = busy || (id === 'runall' && !nb.cells.length);
  for (const u of urls.splice(0)) URL.revokeObjectURL(u);
  const list = $('cells'); list.replaceChildren();
  nb.cells.forEach((c, i) => {
    const ta = el('textarea', { class: c.kind === 'code' ? 'src' : 'note', spellcheck: 'false', rows: String(Math.max(2, c.body.split('\n').length)), 'aria-label': t(c.kind) });
    ta.value = c.body; ta.addEventListener('input', () => { c.body = ta.value; ta.rows = Math.max(2, ta.value.split('\n').length); if (c.kind === 'note') { const m = ta.closest('.cell').querySelector('.md'); m.replaceChildren(...mdParse(c.body).map(blk)); } });
    const btn = (key, fn, dis = false) => { const b = el('button', { type: 'button', class: 'btn btn--sm', onclick: fn }, t(key)); b.disabled = busy || dis; return b; };
    const bar = el('div', { class: 'cbar' }, el('span', { class: 'num' }, `[${i + 1}] ${t(c.kind)}`),
      ...(c.kind === 'code' ? [btn('run', () => guard(() => runCell(i)))] : []),
      btn('up', () => { [nb.cells[i - 1], nb.cells[i]] = [nb.cells[i], nb.cells[i - 1]]; render(); }, i === 0),
      btn('down', () => { [nb.cells[i + 1], nb.cells[i]] = [nb.cells[i], nb.cells[i + 1]]; render(); }, i === nb.cells.length - 1),
      btn('kind', () => { c.kind = c.kind === 'code' ? 'note' : 'code'; if (c.kind === 'note') { c.saved = c.result = null; } render(); }),
      btn('del', () => { nb.cells.splice(i, 1); render(); }));
    list.append(el('section', { class: 'cell cell--' + c.kind, 'data-i': String(i) }, bar, ta, ...(c.kind === 'code' ? [outputView(c)] : [el('div', { class: 'md' }, ...mdParse(c.body).map(blk))])));
  });
  $('empty').hidden = nb.cells.length > 0;
  for (const n of document.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
  document.documentElement.lang = LANG();
  window.__nb = nb;
}

// ---- wiring ----
$('title').addEventListener('input', () => { nb.title = $('title').value; });
$('addcode').onclick = () => { nb.cells.push(blank('code')); render(); };
$('addnote').onclick = () => { nb.cells.push(blank('note')); render(); };
$('newnb').onclick = () => { Object.assign(nb, { title: '', created: '', extra: [], cells: [blank('code')] }); notice = ''; render(); };
$('runall').onclick = () => guard(async () => { for (let i = 0; i < nb.cells.length; i++) await runCell(i); });
$('opennb').onclick = () => $('file').click();
$('file').onchange = async () => {
  const fs = [...$('file').files]; $('file').value = ''; if (!fs.length) return;
  const main = fs.find((f) => f.name.endsWith('.isas')) || fs[0];   // pick the .isas and its side files together
  // sizes are checked before anything is read, so a huge file cannot hang the tab
  const big = fs.find((f) => f.size > (f === main ? MAX_ISAS * 4 : MAX_SIDE));   // MAX_ISAS counts characters; 4 octets each at most
  if (big) { fail(new IsasError('IsasTooLarge', `${big.name} is ${big.size} octets`, 0)); return; }
  try { const side = new Map(); for (const f of fs) if (f !== main) side.set(f.name, new Uint8Array(await f.arrayBuffer())); await load(await main.text(), side); render(); } catch (e) { fail(e); }
};
$('savenb').onclick = async () => {
  try {
    const base = (nb.title || 'notebook').replace(/[^\p{L}\p{N}_-]+/gu, '-');
    const { text, files } = await save($('embedall').checked);
    const dl = (bytes, name, type) => { const url = URL.createObjectURL(new Blob([bytes], { type })); const a = el('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); };
    dl(text, base + '.isas', 'text/plain;charset=utf-8');
    for (const [path, bytes] of files) dl(bytes, path.split('/').pop(), 'application/octet-stream');   // the browser cannot make folders: put them in <name>.isas.d/
    notice = files.size ? t('sidenote', base + '.isas.d') : ''; render();
  } catch (e) { fail(e); }
};
$('examples').onchange = async () => {
  const f = $('examples').value; $('examples').value = ''; if (!f) return;
  try { const r = await fetch('examples/' + f); if (!r.ok) throw new Error(f + ': HTTP ' + r.status); await load(await r.text()); render(); } catch (e) { fail(e); }
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
