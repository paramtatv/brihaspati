// SPDX-License-Identifier: AGPL-3.0-only
// Unit test of kernel/library.mjs (the sidebar's storage layer) over fake Storage objects: normal use, corrupt index,
// newer schema, absent / throwing / failing-later / full storage, orphans, and a second tab.   usage: node test/library.mjs
import { Library, IDX, BAD, NB, MAX_BYTES } from '../kernel/library.mjs';

let bad = 0;
const check = (ok, what) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) bad++; };
const fake = (o = {}) => { const m = new Map(Object.entries(o.init ?? {})); return { m, getItem: (k) => { if (o.get) throw o.get(); return m.has(k) ? m.get(k) : null; }, setItem: (k, v) => { if (o.set?.(k, v)) throw o.set(k, v); m.set(k, String(v)); }, removeItem: (k) => { if (o.rm) throw o.rm(); m.delete(k); } }; };
const quota = () => Object.assign(new Error('full'), { name: 'QuotaExceededError', code: 22 });
const t0 = (n) => new Date(Date.UTC(2026, 9, 14, 12, n));

// ---- normal use ----
{
  const s = fake(), L = new Library(s);
  check(L.persistent && L.list().length === 0 && L.current === null, 'empty storage: persistent, no notebooks');
  const a = L.create('alpha', 'TEXT-A', t0(1)), b = L.create('beta', 'TEXT-B', t0(2)), c = L.create('gamma', 'TEXT-C', t0(3));
  check(a.ok && b.ok && c.ok && new Set([a.id, b.id, c.id]).size === 3, 'three notebooks created with distinct ids');
  check(L.list().map((r) => r.title).join() === 'gamma,beta,alpha' && L.current === c.id, 'listed newest first; the last created is current');
  check(L.get(a.id).text === 'TEXT-A' && L.get('nope') === null, 'get returns the body; an unknown id is null');
  const L2 = new Library(s);
  check(L2.list().length === 3 && L2.current === c.id && L2.get(b.id).text === 'TEXT-B', 'a second Library on the same storage sees them (reload)');
  check(L.update(a.id, 'TEXT-A', t0(9)).same === true && L.list().find((r) => r.id === a.id).modified === t0(1).toISOString(), 'unchanged text: modified is not touched');
  check(L.update(a.id, 'TEXT-A2', t0(9)).ok && L.list()[0].id === a.id && L.get(a.id).bytes === 7, 'changed text: modified and bytes move; it sorts first');
  check(L.create('alpha', 'x', t0(10)).ok && L.list().some((r) => r.title === 'alpha (2)'), 'title collision becomes "alpha (2)"');
  const r = L.rename(b.id, 'alpha'); check(r.ok && r.title === 'alpha (3)', 'rename onto a taken title gets "(3)"');
  check(L.rename(b.id, 'beta').title === 'beta' && L.rename(b.id, 'beta').title === 'beta', 'renaming to its own title keeps it');
  check(L.setCurrent(a.id).ok && new Library(s).current === a.id && !L.setCurrent('nope').ok, 'setCurrent persists; an unknown id is refused');
  L.remove(a.id);
  check(L.get(a.id) === null && s.getItem(NB + a.id) === null && L.current !== a.id && L.current !== null, 'delete removes body and row and moves current to another notebook');
  for (const x of L.list()) L.remove(x.id);
  check(L.list().length === 0 && L.current === null && !L.remove('zz').ok, 'deleting everything leaves an empty library');
  check(!L.create('big', 'x'.repeat(MAX_BYTES + 1)).ok && L.create('big', 'x'.repeat(MAX_BYTES + 1)).why === 'toolarge', 'a notebook over the cap is refused');
}

// ---- corrupt and foreign data ----
{
  const s = fake({ init: { [IDX]: '{not json' } }), L = new Library(s);
  check(L.list().length === 0 && s.getItem(BAD) === '{not json' && L.persistent, 'corrupt index: library starts empty, the raw text is kept in .bad');
  check(L.create('n', 'T').ok && new Library(s).list().length === 1, 'and it is usable afterwards');
  const s2 = fake({ init: { [IDX]: JSON.stringify({ v: 2, current: 'a', items: [{ id: 'a', title: 'x', modified: 'z', bytes: 1 }] }), [NB + 'a']: 'T' } }), L2 = new Library(s2);
  check(L2.list().length === 0 && s2.getItem(BAD) !== null, 'newer schema version: treated as absent, raw index kept');
  const s3 = fake({ init: { [IDX]: JSON.stringify({ v: 1, current: 'ghost', items: [{ id: 'a', title: 'ok', modified: 'z', bytes: 1 }, { id: 'b', title: 'no body', modified: 'z', bytes: 1 }, { id: '../x', title: 'bad id', modified: 'z', bytes: 1 }, 7, null, { id: 'c' }] }), [NB + 'a']: 'T', [NB + 'orphan']: 'O' } }), L3 = new Library(s3);
  check(L3.list().map((r) => r.id).join() === 'a' && L3.current === null, 'rows without a body, with bad ids or wrong shape are dropped; unknown current becomes null; orphan bodies ignored');
  check(new Library(fake({ init: { [IDX]: 'null' } })).list().length === 0 && new Library(fake({ init: { [IDX]: '[]' } })).list().length === 0 && new Library(fake({ init: { [IDX]: '{"v":1,"items":5}' } })).list().length === 0, 'JSON of the wrong shape is survived');
}

// ---- absent, throwing, failing later, full ----
{
  for (const [name, st] of [['undefined', undefined], ['null', null], ['every call throws', fake({ get: () => new Error('denied'), set: () => new Error('denied'), rm: () => new Error('denied') })]]) {
    const L = new Library(st);
    const a = L.create('a', 'TA', t0(1)), b = L.create('b', 'TB', t0(2));
    check(!L.persistent && a.ok && b.ok && L.list().length === 2 && L.get(a.id).text === 'TA', `storage ${name}: in-memory fallback, persistent=false, create and get work`);
    check(L.rename(a.id, 'b').title === 'b (2)' && L.update(b.id, 'TB2').ok && L.remove(a.id).ok && L.list().length === 1 && L.get(b.id).text === 'TB2', `storage ${name}: rename, update and delete work`);
    L.refresh(); check(L.list().length === 1, `storage ${name}: refresh does not throw or lose rows`);
  }
  let boom = false; const s = fake({ set: () => (boom ? new Error('SecurityError') : null) }), L = new Library(s);
  const a = L.create('a', 'TA', t0(1)); boom = true;
  const b = L.create('b', 'TB', t0(2));
  check(a.ok && b.ok && !L.persistent && L.get(a.id).text === 'TA' && L.get(b.id).text === 'TB' && L.list().length === 2, 'storage that starts failing after the probe: notebooks kept in memory, no throw');
  // quota
  let full = false; const q = fake({ set: () => (full ? quota() : null) }), Q = new Library(q);
  const x = Q.create('x', 'OLD', t0(1)); full = true;
  const u = Q.update(x.id, 'NEWER-AND-LONGER', t0(2));
  check(!u.ok && u.why === 'quota' && Q.get(x.id).text === 'OLD' && q.getItem(NB + x.id) === 'OLD' && Q.persistent, 'quota on update: the old body is kept, why=quota, still persistent');
  const cr = Q.create('y', 'NEW', t0(3));
  check(!cr.ok && cr.why === 'quota' && Q.list().length === 1, 'quota on create: nothing half-created');
  full = false; check(Q.update(x.id, 'NEWER', t0(4)).ok && new Library(q).get(x.id).text === 'NEWER', 'after space is freed, saving works again');
  // the index write is what fails: the body written just before is removed again
  let idxFull = false; const q2 = fake({ set: (k) => (idxFull && k === IDX ? quota() : null) }), Q2 = new Library(q2); idxFull = true;
  const c2 = Q2.create('z', 'ZZ'); check(!c2.ok && c2.why === 'quota' && [...q2.m.keys()].every((k) => !k.startsWith(NB)) && Q2.list().length === 0, 'index write fails: the body is rolled back');
}

// ---- a second tab ----
{
  const s = fake(), A = new Library(s), B = new Library(s);
  const a = A.create('from A', 'TA', t0(1)); const b = B.create('from B', 'TB', t0(2));
  A.refresh(); B.refresh();
  check(A.list().length === 2 && B.list().length === 2 && A.get(b.id).text === 'TB', 'refresh merges the other tab\'s notebooks');
  check(A.current === a.id, 'refresh keeps this tab\'s own current notebook');
  B.remove(a.id); A.refresh();
  check(!A.list().some((r) => r.id === a.id), 'a notebook deleted in the other tab disappears on refresh');
}
console.log(bad ? `${bad} FAILED` : 'all ok'); process.exit(bad ? 1 : 0);
