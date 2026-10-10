// SPDX-License-Identifier: AGPL-3.0-only
// Markdown subset -> a plain tree (never HTML). Headings, emphasis, lists, code spans and blocks, links, tables, images,
// block quotes, rules. Raw HTML is ordinary text. The page turns the tree into DOM with textContent only.
// Block: {t:'h',n,c} {t:'p',c} {t:'ul'|'ol',items:[c]} {t:'pre',lang,v} {t:'table',head:[c],rows:[[c]]} {t:'quote',c} {t:'hr'}
// Inline: {t:'text',v} {t:'em',c} {t:'strong',c} {t:'code',v} {t:'a',href,c} {t:'img',src,alt}
export const safeHref = (h) => /^(https?:|mailto:|#)/i.test(h) || (!/^[a-z][a-z0-9+.-]*:/i.test(h) && !h.startsWith('//'));
// a relative image path: no scheme, no leading slash, no '..' segment, no backslash
export const safeRelPath = (p) => !/^[a-z][a-z0-9+.-]*:/i.test(p) && !p.startsWith('/') && !p.startsWith('//') && !p.includes('\\') && !p.split('/').includes('..') && p.length > 0;

export function inline(s) {
  const out = []; let buf = '', i = 0;
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && /[\\`*_\[\]()!#|<>-]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (c === '`') { const j = s.indexOf('`', i + 1); if (j > 0) { flush(); out.push({ t: 'code', v: s.slice(i + 1, j) }); i = j + 1; continue; } }
    if ((c === '*' || c === '_') && s[i + 1] === c) { const j = s.indexOf(c + c, i + 2); if (j > i + 2) { flush(); out.push({ t: 'strong', c: inline(s.slice(i + 2, j)) }); i = j + 2; continue; } }
    if (c === '*' || c === '_') { const j = s.indexOf(c, i + 1); if (j > i + 1 && !/\s/.test(s[i + 1]) && !(c === '_' && /\w/.test(s[i - 1] ?? ' '))) { flush(); out.push({ t: 'em', c: inline(s.slice(i + 1, j)) }); i = j + 1; continue; } }
    if (c === '!' && s[i + 1] === '[' || c === '[') {
      const img = c === '!', b = img ? i + 2 : i + 1, k = s.indexOf('](', b);
      if (k > 0) { const e = s.indexOf(')', k + 2); if (e > 0) {
        const label = s.slice(b, k), url = s.slice(k + 2, e).trim().split(/\s+/)[0];
        flush();
        if (img) out.push({ t: 'img', src: url, alt: label });
        else out.push(safeHref(url) ? { t: 'a', href: url, c: inline(label) } : { t: 'text', v: label });
        i = e + 1; continue; } }
    }
    buf += c; i++;
  }
  flush(); return out;
}
const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((x) => x.trim());
export function blocks(text) {
  const L = text.split('\n'), out = []; let i = 0;
  while (i < L.length) {
    const l = L[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = /^```\s*([\w+-]*)\s*$/.exec(l))) { const v = []; i++; while (i < L.length && !/^```\s*$/.test(L[i])) v.push(L[i++]); i++; out.push({ t: 'pre', lang: m[1], v: v.join('\n') }); continue; }
    if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l))) { out.push({ t: 'h', n: m[1].length, c: inline(m[2]) }); i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { out.push({ t: 'hr' }); i++; continue; }
    if (/^>\s?/.test(l)) { const v = []; while (i < L.length && /^>\s?/.test(L[i])) v.push(L[i++].replace(/^>\s?/, '')); out.push({ t: 'quote', c: blocks(v.join('\n')) }); continue; }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l), items = [];
      while (i < L.length && (m = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(L[i]))) { items.push(inline(m[1])); i++; }
      out.push({ t: ordered ? 'ol' : 'ul', items }); continue;
    }
    if (l.includes('|') && i + 1 < L.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(L[i + 1])) {
      const head = cells(l).map(inline), rows = []; i += 2;
      while (i < L.length && L[i].includes('|') && L[i].trim()) rows.push(cells(L[i++]).map(inline));
      out.push({ t: 'table', head, rows }); continue;
    }
    const p = []; while (i < L.length && L[i].trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s)/.test(L[i])) p.push(L[i++]);
    if (!p.length) { p.push(L[i++]); }
    out.push({ t: 'p', c: inline(p.join(' ')) });
  }
  return out;
}
export const mdParse = blocks;
