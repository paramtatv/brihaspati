// SVG sanitiser: an allowlist re-serialiser. No DOM; node and browser. sanitizeSvg(text) -> a safe SVG string, or null
// when the text is not an SVG document. Dropped with their whole subtree: script, foreignObject, style, animate*, set,
// image, a, iframe, object, embed, and any unknown element. Dropped outright: comments, CDATA, DOCTYPE/ENTITY, processing
// instructions. Attributes: allowlist only; no on*; href only to a #fragment; no url() except to a #fragment; no javascript:.
const ELEMENTS = new Set('svg g defs path rect circle ellipse line polyline polygon text tspan title desc lineargradient radialgradient stop clippath mask use symbol pattern marker'.split(' '));
const ATTRS = new Set(`id class x y x1 y1 x2 y2 cx cy r rx ry width height viewbox preserveaspectratio d points transform fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset stroke-miterlimit opacity offset stop-color stop-opacity gradientunits gradienttransform fx fy clip-path clip-rule mask maskunits maskcontentunits patternunits patterntransform markerwidth markerheight refx refy orient markerunits font-family font-size font-weight font-style text-anchor dominant-baseline dx dy rotate textlength lengthadjust letter-spacing xmlns xmlns:xlink version style href xlink:href`.split(/\s+/));
const esc = (s) => s.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const cleanVal = (name, v) => {
  const flat = v.replace(/&#x?[0-9a-f]+;?/gi, (m) => m).replace(/[\s\u0000-\u001f]+/g, '').toLowerCase();
  if (/javascript:|vbscript:|data:|expression\(|@import|<|&#/.test(flat)) return null;
  if (name === 'href' || name === 'xlink:href') return /^#[\w.:-]+$/.test(v.trim()) ? v.trim() : null;
  if (name === 'xmlns') return v === 'http://www.w3.org/2000/svg' ? v : null;
  if (name === 'xmlns:xlink') return v === 'http://www.w3.org/1999/xlink' ? v : null;
  for (const m of flat.matchAll(/url\(([^)]*)\)/g)) if (!/^['"]?#[\w.:-]+['"]?$/.test(m[1])) return null;
  return v;
};
export function sanitizeSvg(text) {
  const out = []; const stack = []; let i = 0, skip = null, sawRoot = false;
  const n = text.length;
  while (i < n) {
    if (text[i] !== '<') {
      const j = text.indexOf('<', i); const end = j < 0 ? n : j;
      if (!skip && stack.length) out.push(esc(text.slice(i, end)).replace(/>/g, '&gt;'));
      i = end; continue;
    }
    if (text.startsWith('<!--', i)) { const j = text.indexOf('-->', i + 4); i = j < 0 ? n : j + 3; continue; }
    if (text.startsWith('<![CDATA[', i)) { const j = text.indexOf(']]>', i); i = j < 0 ? n : j + 3; continue; }   // CDATA is dropped
    if (text[i + 1] === '!' || text[i + 1] === '?') { const j = text.indexOf('>', i); i = j < 0 ? n : j + 1; continue; }
    // a tag: scan to its closing '>' respecting quotes
    let j = i + 1, q = null;
    for (; j < n; j++) { const c = text[j]; if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') break; }
    if (j >= n) return null;
    const raw = text.slice(i + 1, j); i = j + 1;
    const closing = raw[0] === '/';
    const m = /^\/?\s*([A-Za-z][\w:.-]*)([\s\S]*?)(\/?)$/.exec(raw);
    if (!m) continue;
    const name = m[1].toLowerCase(), selfClose = m[3] === '/';
    if (closing) {
      if (skip) { if (name === skip.name && --skip.depth === 0) skip = null; continue; }
      const top = stack[stack.length - 1];
      if (top === name) { stack.pop(); out.push(`</${name === 'lineargradient' ? 'linearGradient' : name === 'radialgradient' ? 'radialGradient' : name === 'clippath' ? 'clipPath' : name}>`); }
      continue;
    }
    if (skip) { if (name === skip.name && !selfClose) skip.depth++; continue; }
    if (!ELEMENTS.has(name) || (!sawRoot && name !== 'svg') || (sawRoot && name === 'svg' && stack.length === 0)) { if (!selfClose) skip = { name, depth: 1 }; if (!sawRoot && name !== 'svg') return null; continue; }
    sawRoot = true;
    let attrs = '';
    for (const a of m[2].matchAll(/([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      const an = a[1].toLowerCase(); if (!ATTRS.has(an) || an.startsWith('on')) continue;
      const v = a[2] ?? a[3] ?? a[4] ?? ''; const cv = cleanVal(an, v); if (cv === null) continue;
      attrs += ` ${an === 'viewbox' ? 'viewBox' : an === 'preserveaspectratio' ? 'preserveAspectRatio' : an}="${esc(cv)}"`;
    }
    const tagName = { lineargradient: 'linearGradient', radialgradient: 'radialGradient', clippath: 'clipPath' }[name] ?? name;
    if (name === 'svg' && stack.length === 0 && !/ xmlns=/.test(attrs)) attrs = ' xmlns="http://www.w3.org/2000/svg"' + attrs;
    if (selfClose) out.push(`<${tagName}${attrs}/>`); else { out.push(`<${tagName}${attrs}>`); stack.push(name); }
  }
  if (!sawRoot) return null;
  while (stack.length) { const nm = stack.pop(); out.push(`</${nm === 'lineargradient' ? 'linearGradient' : nm === 'radialgradient' ? 'radialGradient' : nm === 'clippath' ? 'clipPath' : nm}>`); }
  return out.join('');
}
