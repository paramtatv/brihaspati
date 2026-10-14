// SPDX-License-Identifier: AGPL-3.0-only
// Notebook library: a list of saved notebooks (.isas text) kept in a Storage-shaped object. Pure; node and browser.
// Schema v1: key IDX = {v:1, current, items:[{id,title,modified,bytes}]}, key NB+id = the .isas text.
// Absent, blocked, corrupt or too-new storage never throws out of here: the library falls back to memory (persistent=false).
export const IDX = 'brih.lib.v1.index', BAD = IDX + '.bad', NB = 'brih.lib.v1.nb.', MAX_BYTES = 4 << 20;

const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } }; };
const isQuota = (e) => !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
const okRow = (r) => r && typeof r.id === 'string' && /^[\w-]{1,40}$/.test(r.id) && typeof r.title === 'string' && typeof r.modified === 'string' && Number.isFinite(r.bytes);

export class Library {
  constructor(storage) {
    this.persistent = true; this.lastError = null; this.gone = new Set(); this.store = storage;
    try { if (!storage) throw new Error('none'); const k = NB + 'probe'; storage.setItem(k, '1'); storage.removeItem(k); } catch { this.persistent = false; this.store = memStore(); }
    this.#readIndex();
  }
  #safe(fn, fallback = null) { try { return fn(); } catch (e) { this.lastError = isQuota(e) ? 'quota' : 'storage'; if (!isQuota(e)) this.#demote(); return fallback; } }
  // a storage that starts failing after the probe: keep what we have in memory and stop touching it
  #demote() { if (!this.persistent) return; const old = this.store, mem = memStore(); this.persistent = false; this.store = mem; for (const r of this.items) { try { const t = old.getItem(NB + r.id); if (t !== null) mem.setItem(NB + r.id, t); } catch {} } }
  #readIndex() {
    this.items = []; this.current = null;
    const raw = this.#safe(() => this.store.getItem(IDX));
    if (raw === null) return;
    let j = null; try { j = JSON.parse(raw); } catch {}
    if (!j || j.v !== 1 || !Array.isArray(j.items)) { this.#safe(() => this.store.setItem(BAD, raw)); return; }   // corrupt or newer: keep the raw copy, start empty
    this.items = j.items.filter(okRow).filter((r) => this.#safe(() => this.store.getItem(NB + r.id)) !== null);
    this.current = this.items.some((r) => r.id === j.current) ? j.current : null;
  }
  // rows another tab added since we last read are kept (unless we deleted them): the index is re-read before every write
  #mergeForeign() {
    const raw = this.#safe(() => this.store.getItem(IDX)); let j = null; try { j = JSON.parse(raw); } catch {}
    if (!j || j.v !== 1 || !Array.isArray(j.items)) return;
    const have = new Set(this.items.map((r) => r.id));
    for (const r of j.items) if (okRow(r) && !have.has(r.id) && !this.gone.has(r.id) && this.#safe(() => this.store.getItem(NB + r.id)) !== null) this.items.push(r);
  }
  #writeIndex() {
    this.#mergeForeign();
    const body = JSON.stringify({ v: 1, current: this.current, items: this.items });
    try { this.store.setItem(IDX, body); return { ok: true }; } catch (e) { this.lastError = isQuota(e) ? 'quota' : 'storage'; if (!isQuota(e)) this.#demote(); return { ok: false, why: this.lastError }; }
  }
  // merge another tab's changes: rows we do not know are added; our own rows win; our current id is kept
  refresh() {
    const mine = new Map(this.items.map((r) => [r.id, r])), cur = this.current;
    this.#readIndex();
    for (const r of this.items) if (!mine.has(r.id)) mine.set(r.id, r);
    this.items = [...mine.values()].filter((r) => this.#safe(() => this.store.getItem(NB + r.id)) !== null);
    this.current = this.items.some((r) => r.id === cur) ? cur : this.current;
  }
  list() { return [...this.items].sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : a.id < b.id ? -1 : 1)); }
  get(id) { const r = this.items.find((x) => x.id === id); if (!r) return null; const text = this.#safe(() => this.store.getItem(NB + id)); return text === null ? null : { ...r, text }; }
  #uniq(title, except) {
    const t = title.trim(), taken = new Set(this.items.filter((r) => r.id !== except).map((r) => r.title));
    if (!taken.has(t)) return t;
    for (let n = 2; ; n++) if (!taken.has(`${t} (${n})`)) return `${t} (${n})`;
  }
  // text: the .isas text; title: its title ('' = untitled label chosen by the caller). Returns {ok, id} or {ok:false, why}.
  create(title, text, now = new Date()) {
    if (text.length > MAX_BYTES) return { ok: false, why: 'toolarge' };
    const id = 'n' + now.getTime().toString(36) + Math.random().toString(36).slice(2, 5);
    try { this.store.setItem(NB + id, text); } catch (e) { this.lastError = isQuota(e) ? 'quota' : 'storage'; if (!isQuota(e)) { this.#demote(); return this.create(title, text, now); } return { ok: false, why: 'quota' }; }
    this.items.push({ id, title: this.#uniq(title), modified: now.toISOString(), bytes: text.length }); this.current = id;
    const w = this.#writeIndex(); if (!w.ok) { this.items = this.items.filter((r) => r.id !== id); this.#safe(() => this.store.removeItem(NB + id)); this.current = null; return w; }
    return { ok: true, id };
  }
  // replace the body of id; modified changes only if the text changed
  update(id, text, now = new Date()) {
    const r = this.items.find((x) => x.id === id); if (!r) return { ok: false, why: 'missing' };
    if (text.length > MAX_BYTES) return { ok: false, why: 'toolarge' };
    const old = this.#safe(() => this.store.getItem(NB + id)); if (old === text) return { ok: true, same: true };
    try { this.store.setItem(NB + id, text); } catch (e) { this.lastError = isQuota(e) ? 'quota' : 'storage'; if (!isQuota(e)) { this.#demote(); return this.update(id, text, now); } return { ok: false, why: 'quota' }; }
    r.modified = now.toISOString(); r.bytes = text.length; return this.#writeIndex();
  }
  rename(id, title) { const r = this.items.find((x) => x.id === id); if (!r) return { ok: false, why: 'missing' }; r.title = this.#uniq(title, id); const w = this.#writeIndex(); return w.ok ? { ok: true, title: r.title } : w; }
  setCurrent(id) { if (!this.items.some((r) => r.id === id)) return { ok: false, why: 'missing' }; this.current = id; return this.#writeIndex(); }
  // body first, then the index: a crash between leaves an orphan body that nothing reads
  remove(id) {
    if (!this.items.some((r) => r.id === id)) return { ok: false, why: 'missing' };
    this.#safe(() => this.store.removeItem(NB + id)); this.items = this.items.filter((r) => r.id !== id); this.gone.add(id);
    if (this.current === id) this.current = this.list()[0]?.id ?? null;
    return this.#writeIndex();
  }
}
