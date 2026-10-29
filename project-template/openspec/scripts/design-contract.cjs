'use strict';
/*
 * design-contract.cjs - the design-to-code contract used by verify-task.cjs and visual-check.cjs. Plain Node >= 18.
 *
 * 1. Design system discovery (`verify-task.cjs design-system`): project tokens (CSS custom properties, Tailwind v4
 *    @theme, tokens.json / style-dictionary output, Tailwind config theme values, Nuxt UI app.config colours) and
 *    shared components with their variant-like props. /spec-explore runs it before mapping a design.
 * 2. The design map (<change>/design-map.md, written during explore): one table row per design region/element with
 *    the selector, what implements it and the SOURCE of that mapping (token | component | framework | arbitrary), plus
 *    Gaps (no matching token/component, never invented silently) and Questions for the designer. `lint` checks that
 *    every element of a scenario with a `reference:` has a row, that `arbitrary` rows have a gap entry and that
 *    `token:` names exist.
 * 3. Expectations: `expect:` lines in ```visual blocks, derived from the map, checked deterministically in the
 *    browser from computed styles and geometry (no screenshots):
 *      expect: <selector> <css-property> ~|=|!= <value>          [@375 | @375,768 | @>=768 | @<768]
 *      expect: <a> <relation> <b> [~ <px or token>]              [@...]
 *    value: a CSS value (#2563eb, 24px, 1.5rem, 700, uppercase) or token:<name> (the project's custom property
 *    --<name>, resolved in the page). `~` tolerates ΔE76 <= 6 for colours and max(1px, 8%) for lengths; `=` is exact.
 *    relations: left-with right-with top-with bottom-with center-with middle-with (edges within 2px, or ~ N),
 *    before (reading order), above below left-of right-of same-row stacked same-width same-height inside,
 *    gap-to (~ <length>: distance between the nearest edges).
 * 4. Token lint over changed UI files: arbitrary values / raw hex equal to a project token value are errors (use the
 *    token); other arbitrary values, inline styles and stock palette classes (when the project defines colour tokens)
 *    are warnings unless design-map.md records them as a gap.
 * 5. Reviewer side-by-side: an ephemeral image of the rendered area next to the (cropped) design reference, plus a
 *    6-item rubric (layout, hierarchy, spacing, colour, typography, components) the reviewer must cite item by item.
 */
const fs = require('fs');
const path = require('path');

const RELATIONS = ['left-with', 'right-with', 'top-with', 'bottom-with', 'center-with', 'middle-with', 'before', 'above', 'below', 'left-of', 'right-of', 'same-row', 'stacked', 'same-width', 'same-height', 'inside', 'gap-to'];
const SOURCES = ['token', 'component', 'framework', 'arbitrary'];
const RUBRIC_ITEMS = ['layout', 'hierarchy', 'spacing', 'colour', 'typography', 'components'];

// ---------- expect: parsing ----------
function parseVps(f) {
  if (!f) return null;
  const m = f.match(/^([<>]=?)?\s*(\d+(?:\s*,\s*\d+)*)$/); if (!m) return { error: `bad viewport filter "@${f}" (use @375, @375,768, @>=768 or @<768)` };
  const nums = m[2].split(/\s*,\s*/).map(Number);
  if (m[1] && nums.length > 1) return { error: `bad viewport filter "@${f}"` };
  return { op: m[1] || 'in', nums };
}
function vpMatch(f, vw) {
  if (!f) return true;
  const n = f.nums[0];
  switch (f.op) { case '<': return vw < n; case '<=': return vw <= n; case '>': return vw > n; case '>=': return vw >= n; default: return f.nums.includes(vw); }
}
/** One `expect:` value -> { raw, kind: 'style'|'rel', sel, prop, op, value, rel, other, vps, error } */
function parseExpect(raw) {
  const e = { raw: String(raw).trim(), vps: null };
  let t = e.raw;
  const vm = t.match(/\s+@\s*((?:[<>]=?)?\s*\d+(?:\s*,\s*\d+)*)\s*$/);
  if (vm) { e.vps = parseVps(vm[1].replace(/\s+/g, '')); if (e.vps.error) return { ...e, error: e.vps.error }; t = t.slice(0, vm.index).trim(); }
  const rel = t.match(new RegExp(`^(.+?)\\s+(${RELATIONS.join('|')})\\s+(.+?)(?:\\s+(~|=)\\s+(\\S+))?$`));
  if (rel) {
    Object.assign(e, { kind: 'rel', sel: rel[1].trim(), rel: rel[2], other: rel[3].trim(), op: rel[4] || null, value: rel[5] || null });
    if (rel[2] === 'gap-to' && !e.value) return { ...e, error: `"gap-to" needs a distance: "${e.sel} gap-to ${e.other} ~ 24px"` };
    return e;
  }
  const st = t.match(/^(.+?)\s+([a-z][a-z-]*)\s*(!=|~|=)\s*(.+)$/);
  if (st) return Object.assign(e, { kind: 'style', sel: st[1].trim(), prop: st[2], op: st[3], value: st[4].trim() });
  return { ...e, error: `cannot read expect "${e.raw}": use "<selector> <css-property> ~|=|!= <value>" or "<a> <${RELATIONS.slice(0, 3).join('|')}|...> <b>"` };
}
const expectSelectors = (x) => (x.error ? [] : x.kind === 'rel' ? [x.sel, x.other] : [x.sel]);
const tokenRefs = (x) => [x.value].filter((v) => v && /^token:/.test(v)).map((v) => v.slice(6));

// ---------- in-page evaluation (serialised into the browser by Playwright) ----------
/* eslint-disable no-undef */
function pageExpect(arg) {
  const vw = window.innerWidth; const out = [];
  const cv = document.createElement('canvas'); cv.width = 1; cv.height = 1; const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (c) => {
    if (!c || c === 'none') return null;
    cx.fillStyle = '#010203'; cx.fillStyle = c; if (cx.fillStyle === '#010203' && !/^#010203$/i.test(c)) return null;
    cx.clearRect(0, 0, 1, 1); cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3]];
  };
  const lab = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const R = f(r); const G = f(g); const B = f(b);
    const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047; const Y = R * 0.2126 + G * 0.7152 + B * 0.0722; const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const h = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * h(Y) - 16, 500 * (h(X) - h(Y)), 200 * (h(Y) - h(Z))];
  };
  const dE = (a, b) => { const A = lab(a); const B = lab(b); return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]); };
  const hex = (c) => '#' + c.slice(0, 3).map((x) => x.toString(16).padStart(2, '0')).join('');
  const ALIAS = { radius: 'border-top-left-radius', 'border-radius': 'border-top-left-radius', 'border-color': 'border-top-color', 'border-width': 'border-top-width', 'border-style': 'border-top-style', bg: 'background-color', background: 'background-color' };
  const visible = (e) => { const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const all = (sel) => { try { return [...document.querySelectorAll(sel)].filter(visible); } catch (e) { return null; } };
  const probe = document.createElement('div'); probe.style.cssText = 'position:absolute;left:-9999px;top:0;display:flex;visibility:hidden'; document.body.appendChild(probe);
  const resolve = (prop, value) => {
    let v = value;
    if (/^token:/.test(v)) {
      const name = v.slice(6).replace(/^--/, '');
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim();
      if (!raw) return { error: `token --${name} is not defined in this page` };
      v = `var(--${name})`;
    }
    const p = prop === 'width' || prop === 'height' ? 'width' : prop;
    probe.style.removeProperty(p); probe.style.setProperty(p, v);
    const got = probe.style.getPropertyValue(p) ? getComputedStyle(probe).getPropertyValue(p).trim() : '';
    probe.style.removeProperty(p);
    return { value: got || value, label: value };
  };
  const nums = (s) => { const parts = String(s).trim().split(/\s+/); const n = parts.map((x) => (/^-?[\d.]+(px)?$/.test(x) ? parseFloat(x) : NaN)); return n.some(Number.isNaN) ? null : n; };
  const expand = (a, n) => (a.length === n ? a : a.length === 1 ? Array(n).fill(a[0]) : a.length === 2 && n === 4 ? [a[0], a[1], a[0], a[1]] : a.length === 3 && n === 4 ? [a[0], a[1], a[2], a[1]] : a);
  const colorProp = (p) => /color$|^fill$|^stroke$|^outline-color$/.test(p);
  const compare = (prop, op, got, want) => {
    const w = want.value;
    if (colorProp(prop) || /^(#|rgb|hsl|oklch|oklab|lab|lch|color\()/i.test(w)) {
      const a = rgba(got); const b = rgba(w);
      if (!a || !b) return { ok: op === '!=' ? got !== w : got === w, detail: `${got}` };
      const d = a[3] === 0 && b[3] === 0 ? 0 : (a[3] === 0) !== (b[3] === 0) ? 100 : dE(a, b);
      const ok = op === '!=' ? d > 6 : d <= (op === '=' ? 1.5 : 6);
      return { ok, detail: `${a[3] === 0 ? 'transparent' : hex(a)} (ΔE ${d.toFixed(1)} from ${b[3] === 0 ? 'transparent' : hex(b)})` };
    }
    if (prop === 'font-family') { const f = (s) => s.split(',')[0].replace(/["']/g, '').trim().toLowerCase(); const ok = f(got) === f(w); return { ok: op === '!=' ? !ok : ok, detail: got }; }
    const A = nums(got); const B = nums(w);
    if (A && B) {
      const n = Math.max(A.length, B.length); const a = expand(A, n); const b = expand(B, n);
      if (a.length !== b.length) return { ok: op === '!=', detail: got };
      const weight = prop === 'font-weight';
      const close = a.every((x, i) => Math.abs(x - b[i]) <= (op === '=' ? 0.5 : weight ? 50 : Math.max(1, 0.08 * Math.abs(b[i]))));
      return { ok: op === '!=' ? !close : close, detail: `${got}${weight ? '' : ''}` };
    }
    const norm = (s) => String(s).toLowerCase().replace(/["']/g, '').replace(/\s+/g, ' ').trim();
    const eq = norm(got) === norm(w);
    return { ok: op === '!=' ? !eq : eq, detail: got };
  };
  const desc = (e) => e.tagName.toLowerCase() + (e.getAttribute('data-testid') ? `[data-testid="${e.getAttribute('data-testid')}"]` : '');
  for (const x of arg.expects) {
    const res = { raw: x.raw, ok: true, message: null };
    out.push(res);
    const fail = (m) => { res.ok = false; res.message = m; };
    const A = all(x.sel);
    if (A === null) { fail(`invalid selector ${x.sel}`); continue; }
    if (!A.length) { fail(`${x.sel} is not visible in the page`); continue; }
    if (x.kind === 'style') {
      const prop = ALIAS[x.prop] || x.prop;
      const want = resolve(prop, x.value);
      if (want.error) { fail(want.error); continue; }
      for (const [i, e] of A.entries()) {
        let got;
        if (prop === 'width' || prop === 'height') got = `${Math.round(e.getBoundingClientRect()[prop] * 10) / 10}px`;
        else got = getComputedStyle(e).getPropertyValue(prop).trim();
        if (!got && prop !== 'content') { fail(`unknown CSS property "${x.prop}"`); break; }
        const c = compare(prop, x.op, got, want);
        if (!c.ok) { fail(`${A.length > 1 ? `match ${i + 1} of ${A.length} (${desc(e)}): ` : ''}${x.prop} is ${c.detail}, expected ${x.op} ${want.label}${want.value !== want.label ? ` (${want.value})` : ''}`); break; }
      }
      continue;
    }
    const B = all(x.other);
    if (B === null) { fail(`invalid selector ${x.other}`); continue; }
    if (!B.length) { fail(`${x.other} is not visible in the page`); continue; }
    let tol = 2;
    let dist = null;
    if (x.value) { const r = resolve('width', x.value); if (r.error) { fail(r.error); continue; } const n = parseFloat(r.value); if (Number.isNaN(n)) { fail(`cannot read the distance "${x.value}"`); continue; } if (x.rel === 'gap-to') dist = n; else tol = n; }
    const b = B[0].getBoundingClientRect();
    for (const [i, e] of A.entries()) {
      if (e === B[0] && A.length > 1) continue;
      const a = e.getBoundingClientRect(); const who = A.length > 1 ? `match ${i + 1} of ${A.length} of ${x.sel}` : x.sel;
      const vOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      const sameRow = vOverlap > 0.5 * Math.min(a.height, b.height);
      const px = (n) => `${Math.round(n)}px`;
      let ok = true; let why = '';
      switch (x.rel) {
        case 'left-with': ok = Math.abs(a.left - b.left) <= tol; why = `left edges differ by ${px(a.left - b.left)}`; break;
        case 'right-with': ok = Math.abs(a.right - b.right) <= tol; why = `right edges differ by ${px(a.right - b.right)}`; break;
        case 'top-with': ok = Math.abs(a.top - b.top) <= tol; why = `top edges differ by ${px(a.top - b.top)}`; break;
        case 'bottom-with': ok = Math.abs(a.bottom - b.bottom) <= tol; why = `bottom edges differ by ${px(a.bottom - b.bottom)}`; break;
        case 'center-with': ok = Math.abs((a.left + a.right) / 2 - (b.left + b.right) / 2) <= tol; why = `horizontal centres differ by ${px((a.left + a.right) / 2 - (b.left + b.right) / 2)}`; break;
        case 'middle-with': ok = Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) <= tol; why = `vertical centres differ by ${px((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2)}`; break;
        case 'before': ok = sameRow ? a.left < b.left : a.top < b.top; why = sameRow ? `it is ${a.left < b.left ? 'left of' : 'right of'} ${x.other} on the same row` : `it is ${a.top < b.top ? 'above' : 'below'} ${x.other}`; break;
        case 'above': ok = a.bottom <= b.top + tol; why = `its bottom is at ${px(a.bottom)}, ${x.other} starts at ${px(b.top)}`; break;
        case 'below': ok = a.top >= b.bottom - tol; why = `its top is at ${px(a.top)}, ${x.other} ends at ${px(b.bottom)}`; break;
        case 'left-of': ok = a.right <= b.left + tol; why = `its right edge is at ${px(a.right)}, ${x.other} starts at ${px(b.left)}`; break;
        case 'right-of': ok = a.left >= b.right - tol; why = `its left edge is at ${px(a.left)}, ${x.other} ends at ${px(b.right)}`; break;
        case 'same-row': ok = sameRow; why = `they are not on one row (vertical overlap ${px(Math.max(0, vOverlap))})`; break;
        case 'stacked': ok = !sameRow; why = 'they are side by side on one row'; break;
        case 'same-width': ok = Math.abs(a.width - b.width) <= tol; why = `widths ${px(a.width)} vs ${px(b.width)}`; break;
        case 'same-height': ok = Math.abs(a.height - b.height) <= tol; why = `heights ${px(a.height)} vs ${px(b.height)}`; break;
        case 'inside': ok = a.left >= b.left - tol && a.right <= b.right + tol && a.top >= b.top - tol && a.bottom <= b.bottom + tol; why = 'it sticks out of the container'; break;
        case 'gap-to': { const g = sameRow ? Math.max(b.left - a.right, a.left - b.right) : Math.max(b.top - a.bottom, a.top - b.bottom); ok = Math.abs(g - dist) <= (x.op === '=' ? 0.5 : Math.max(1, 0.08 * dist)); why = `the gap is ${px(g)}, expected ${x.op || '~'} ${x.value}${/^token:/.test(x.value) ? ` (${px(dist)})` : ''}`; break; }
        default: ok = false; why = `unknown relation ${x.rel}`;
      }
      if (!ok) { fail(`${who} is not ${x.rel} ${x.other}: ${why}`); break; }
    }
  }
  probe.remove();
  return out;
}
/* eslint-enable no-undef */

// ---------- design system discovery (static) ----------
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.output', 'coverage', 'openspec', '.cursor', '.claude', '.codex', '.agents', 'vendor', '.svelte-kit', 'storybook-static']);
function walk(dir, pred, max = 4000) {
  const out = []; const stack = [dir];
  while (stack.length && out.length < max) {
    const d = stack.pop(); let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(p); } else if (pred(p)) out.push(p);
    }
  }
  return out.sort();
}
function normValue(v) {
  const s = String(v).trim().toLowerCase().replace(/\s*!important$/, '');
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) { let h = m[1]; if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join(''); return '#' + h.slice(0, 6) + (h.length === 8 && h.slice(6) !== 'ff' ? h.slice(6) : ''); }
  m = s.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/);
  if (m && (!m[4] || m[4] === '1' || m[4] === '100%')) return '#' + [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('');
  m = s.match(/^(-?[\d.]+)(px|rem)$/); if (m) return `${+(m[2] === 'rem' ? +m[1] * 16 : +m[1]).toFixed(3)}px`;
  return s.replace(/\s+/g, ' ');
}
/** Tailwind v4 theme namespace -> utility prefixes a token is used through. */
const NS = [
  ['color-', ['bg', 'text', 'border', 'ring', 'outline', 'fill', 'stroke', 'from', 'via', 'to', 'divide', 'accent', 'caret', 'decoration', 'shadow', 'placeholder']],
  ['spacing-', ['p', 'px', 'py', 'pt', 'pr', 'pb', 'pl', 'm', 'mx', 'my', 'mt', 'mr', 'mb', 'ml', 'gap', 'gap-x', 'gap-y', 'space-x', 'space-y', 'w', 'h', 'size', 'inset', 'top', 'left', 'right', 'bottom']],
  ['radius-', ['rounded', 'rounded-t', 'rounded-b', 'rounded-l', 'rounded-r']],
  ['text-', ['text']], ['font-weight-', ['font']], ['font-', ['font']], ['shadow-', ['shadow']], ['breakpoint-', []], ['container-', ['max-w', 'w']], ['leading-', ['leading']], ['tracking-', ['tracking']],
];
function utilitiesFor(name) {
  for (const [ns, pre] of NS) if (name.startsWith(ns) && !name.includes('--')) { const k = name.slice(ns.length); return ns === 'breakpoint-' ? [`${k}:`] : pre.map((p) => `${p}-${k}`); }
  return [];
}
function discover(codeRoot) {
  const ds = { tokens: [], components: [], sources: [], tailwind: null, ui_library: [] };
  const rel = (f) => path.relative(codeRoot, f);
  const add = (name, value, file, kind) => { if (!ds.tokens.some((t) => t.name === name && t.file === file)) ds.tokens.push({ name, value: String(value).trim(), norm: normValue(value), file, kind, utilities: kind === 'tailwind-theme' ? utilitiesFor(name) : [] }); };
  // CSS custom properties (Tailwind v4 @theme blocks become utilities; :root vars are used via var(--x) or shadcn-style mappings)
  for (const f of walk(codeRoot, (p) => /\.(css|scss|sass|less|pcss)$/.test(p) && !/\.(min)\.css$/.test(p))) {
    const text = fs.readFileSync(f, 'utf8'); let any = false;
    const theme = [...text.matchAll(/@theme(?:\s+[a-z]+)?\s*\{([^}]*)\}/g)].map((m) => [m.index, m.index + m[0].length]);
    for (const m of text.matchAll(/(^|[;{\s])--([a-zA-Z0-9_-]+)\s*:\s*([^;{}]+);/g)) {
      const inTheme = theme.some(([a, b]) => m.index >= a && m.index < b);
      add(m[2], m[3], rel(f), inTheme ? 'tailwind-theme' : 'css-var'); any = true;
    }
    if (/@import\s+["']tailwindcss["']|@tailwind\s+base/.test(text)) ds.tailwind = ds.tailwind || { version: /@import\s+["']tailwindcss/.test(text) ? 4 : 3, entry: rel(f) };
    if (any) ds.sources.push({ kind: theme.length ? 'tailwind @theme / css variables' : 'css variables', file: rel(f) });
  }
  // design token JSON (tokens.json, *.tokens.json, style-dictionary sources)
  for (const f of walk(codeRoot, (p) => /(^|[\\/])(tokens?|design-tokens)([\\/].*)?\.json$|\.tokens\.json$/.test(p) && !/package(-lock)?\.json$/.test(p))) {
    let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { continue; }
    const visit = (o, pre) => { if (!o || typeof o !== 'object') return; const v = o.$value !== undefined ? o.$value : o.value; if (v !== undefined && typeof v !== 'object') { add(pre.join('-'), v, rel(f), 'design-token'); return; } for (const [k, x] of Object.entries(o)) if (!k.startsWith('$')) visit(x, [...pre, k]); };
    visit(j, []); ds.sources.push({ kind: 'design tokens (json)', file: rel(f) });
  }
  // Tailwind v3 config: theme / theme.extend literal values (not evaluated)
  for (const f of walk(codeRoot, (p) => /(^|[\\/])tailwind\.config\.(js|cjs|mjs|ts)$/.test(p))) {
    const text = fs.readFileSync(f, 'utf8');
    ds.tailwind = ds.tailwind || { version: 3, entry: rel(f) };
    for (const m of text.matchAll(/['"]?([a-zA-Z][\w-]*)['"]?\s*:\s*['"](#[0-9a-fA-F]{3,8}|-?[\d.]+(?:px|rem))['"]/g)) add(`tw-${m[1]}`, m[2], rel(f), 'tailwind-config');
    if (/presets\s*:/.test(text)) ds.sources.push({ kind: 'tailwind preset (see config)', file: rel(f) });
    ds.sources.push({ kind: 'tailwind config', file: rel(f) });
  }
  // UI library theme config (Nuxt UI app.config, shadcn components.json)
  for (const f of walk(codeRoot, (p) => /(^|[\\/])(app\.config\.(ts|js|mjs)|components\.json)$/.test(p))) {
    const text = fs.readFileSync(f, 'utf8');
    if (/app\.config/.test(f)) { for (const m of text.matchAll(/(primary|secondary|neutral|success|info|warning|error)\s*:\s*['"]([\w-]+)['"]/g)) add(`ui-${m[1]}`, m[2], rel(f), 'ui-library'); ds.ui_library.push({ name: 'nuxt-ui (app.config)', file: rel(f) }); }
    else if (/"aliases"|"tailwind"/.test(text)) ds.ui_library.push({ name: 'shadcn (components.json)', file: rel(f) });
  }
  // shared components and their variant-like props
  const compDir = /(^|[\\/])(components|ui|design-system|lib[\\/]components)([\\/]|$)/;
  for (const f of walk(codeRoot, (p) => /\.(vue|tsx|jsx|svelte)$/.test(p) && compDir.test(path.relative(codeRoot, p)) && !/\.(test|spec|stories)\./.test(p))) {
    const text = fs.readFileSync(f, 'utf8'); const props = {};
    const set = (k, typ) => { const opts = [...typ.matchAll(/['"]([\w-]+)['"]/g)].map((x) => x[1]); const v = opts.length ? [...new Set(opts)] : typ.trim().replace(/\s+/g, ' ').slice(0, 40); if (!props[k] || (Array.isArray(v) && (!Array.isArray(props[k]) || v.length > props[k].length))) props[k] = v; };
    const typed = text.match(/defineProps<\s*\{([\s\S]*?)\}\s*>|interface\s+\w*Props\s*\{([\s\S]*?)\n\}|type\s+\w*Props\s*=\s*\{([\s\S]*?)\}/);
    if (typed) for (const part of (typed[1] || typed[2] || typed[3]).split(/[;\n]/)) { const m = part.match(/^\s*(?:readonly\s+)?([\w-]+)\??\s*:\s*(.+?)\s*,?\s*$/); if (m) set(m[1], m[2]); }
    else for (const m of text.matchAll(/\b(variant|size|tone|intent|color|kind|appearance|featured|block|as)\??\s*:\s*([^;\n,}]+(?:\|[^;\n,}]+)*)/g)) set(m[1], m[2]);
    ds.components.push({ name: path.basename(f).replace(/\.[^.]+$/, ''), file: rel(f), shared: /(^|[\\/])(ui|design-system)[\\/]/.test(rel(f)), props });
  }
  return ds;
}
function formatDesignSystem(ds) {
  const L = [];
  L.push(`Design system sources: ${ds.sources.map((s) => `${s.kind} (${s.file})`).join('; ') || 'none found'}`);
  if (ds.tailwind) L.push(`Tailwind v${ds.tailwind.version} (${ds.tailwind.entry})`);
  if (ds.ui_library.length) L.push(`UI library config: ${ds.ui_library.map((u) => `${u.name} ${u.file}`).join('; ')}`);
  L.push('Tokens (prefer these, in this order: semantic tokens, then components, then framework defaults, arbitrary values last):');
  for (const t of ds.tokens) L.push(`  --${t.name}: ${t.value}  [${t.kind}, ${t.file}]${t.utilities.length ? `  -> ${t.utilities.slice(0, 4).join(' ')}${t.utilities.length > 4 ? ' ...' : ''}` : ''}`);
  L.push('Components:');
  for (const c of ds.components) L.push(`  ${c.name} (${c.file})${c.shared ? ' [shared]' : ''}${Object.keys(c.props).length ? '  ' + Object.entries(c.props).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('|') : v}`).join('; ') : ''}`);
  return L.join('\n');
}

// ---------- the design map ----------
function cells(line) { return line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()); }
/** <change>/design-map.md -> { file, rows: [{ element, selector, impl, source, sourceKind, notes, line }], gaps, questions, sections } or null. */
function readDesignMap(changeDir) {
  const file = path.join(changeDir, 'design-map.md'); if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const map = { file, rows: [], gaps: [], questions: [], sections: [] }; let sec = ''; let header = null;
  lines.forEach((l, i) => {
    const h = l.match(/^##\s+(.*?)\s*$/); if (h) { sec = h[1].toLowerCase(); map.sections.push(sec); header = null; return; }
    if (/^\s*\|/.test(l)) {
      const c = cells(l);
      if (!header) { header = c.map((x) => x.toLowerCase()); return; }
      if (c.every((x) => /^:?-{2,}:?$/.test(x))) return;
      const col = (re) => { const k = header.findIndex((x) => re.test(x)); return k >= 0 ? (c[k] || '').trim() : ''; };
      const selector = col(/selector/).replace(/^`|`$/g, '');
      if (selector) {
        const source = col(/^source/);
        map.rows.push({ element: col(/region|element/), selector, impl: col(/implement|maps? to|with/), source, sourceKind: (source.toLowerCase().match(new RegExp(`^(${SOURCES.join('|')})`)) || [])[1] || null, notes: col(/note|expect/), line: i + 1, section: sec });
      }
      return;
    }
    header = null;
    const b = l.match(/^\s*[-*]\s+(.*)$/);
    if (b && /gap/.test(sec)) map.gaps.push(b[1]);
    if (b && /question/.test(sec)) map.questions.push(b[1]);
  });
  return map;
}
const TYPO = ['font-size', 'font-weight', 'line-height'];
const TYPO_EX = { 'font-size': '18px', 'font-weight': '600', 'line-height': '28px' };
/** A map row that renders text: by its name/selector, or by type utilities in what implements it. */
function isTextRow(r) {
  const label = `${r.element || ''} ${r.selector || ''}`;
  return /\b(heading|headline|title|subtitle|label|price|amount|name|copy|caption|description|text|link|message|status|hint|tagline|badge|button|cta|total|count|eyebrow|paragraph|body)\b|-(title|label|name|price|amount|text|message|status|total|count)\b/i.test(label)
    || /(?:^|\s)(?:[a-z]+:)*(?:text-(?:xs|sm|base|lg|[2-9]?xl|display|title|heading|body|caption|label)|font-(?:thin|light|normal|medium|semibold|bold|extrabold|black)|leading-[\w-]+)\b/.test(r.impl || '');
}
/** Style facts in a map row's Expect column: "font-size ~ token:text-lg; font-weight = 600". Relations are skipped. */
function mapFacts(notes) {
  return String(notes || '').replace(/`/g, '').split(/\s*;\s*/).map((t) => t.trim().match(/^([a-z][a-z-]*)\s*(!=|~|=)\s*(.+?)(?:\s+@.*)?$/)).filter(Boolean).map((m) => ({ prop: m[1], op: m[2], value: m[3] }));
}
const normSel = (s) => String(s).replace(/`/g, '').replace(/'/g, '"').replace(/\s+/g, ' ').trim();

/** lint: design map coverage, sources, gaps, token names and expect syntax. Problems use visual-check's shape. */
function lintDesign(scens, changeDir, root, codeRoot, ds) {
  const problems = []; const rel = (f) => path.relative(root, f);
  const P = (s, severity, text) => problems.push({ file: s ? s.file : path.join(changeDir, 'design-map.md'), line: s ? s.line : 1, scenario: s ? s.id : null, kind: 'design', severity, text });
  const referenced = scens.filter((s) => s.references && s.references.length);
  const withExpect = scens.filter((s) => s.expects && s.expects.length);
  if (!referenced.length && !withExpect.length) return problems;
  ds = ds || discover(codeRoot);
  const tokenNames = new Set(ds.tokens.map((t) => t.name));
  const map = readDesignMap(changeDir);
  for (const s of withExpect) for (const x of s.expects) {
    const at = `${rel(s.file)}:${x.line || s.line}`;
    if (x.error) { P(s, 'error', `${at}: ${x.error}`); continue; }
    if (x.vps && !s.viewports.some((v) => vpMatch(x.vps, v))) P(s, 'error', `${at}: expect "${x.raw}" matches none of the scenario's viewports (${s.viewports.join(', ')})`);
    for (const t of tokenRefs(x)) if (!tokenNames.has(t.replace(/^--/, ''))) P(s, 'error', `${at}: expect "${x.raw}" names token:${t}, but the project defines no --${t.replace(/^--/, '')} (known: ${[...tokenNames].slice(0, 12).join(', ')}${tokenNames.size > 12 ? ', ...' : ''}); run \`verify-task.cjs design-system\``);
    if (x.value && !/^token:/.test(x.value)) { const n = normValue(x.value); const t = ds.tokens.find((k) => k.norm === n && (/^#/.test(n) || /px$/.test(n))); if (t) P(s, 'info', `${at}: expect "${x.raw}" uses a raw value equal to --${t.name}; prefer token:${t.name}`); }
  }
  if (!referenced.length) return problems;
  if (!map) { P(null, 'error', `design-map.md is missing from the change: ${referenced.length} visual scenario(s) have a design reference (${referenced.map((s) => s.id).join(', ')}). Write the design map during /spec-explore (or now): one row per design region with its selector, what implements it and the source (token | component | framework | arbitrary)`); return problems; }
  const mf = path.relative(root, map.file);
  if (!map.rows.length) P(null, 'error', `${mf}: no map rows (a table with Region/element | Selector | Implemented with | Source columns)`);
  const mapped = new Set(map.rows.map((r) => normSel(r.selector)));
  for (const s of referenced) {
    const sels = [...new Set([...s.keys, ...s.states.flatMap((x) => x.keys), ...(s.expects || []).flatMap(expectSelectors)].map(normSel))];
    for (const sel of sels) if (!mapped.has(sel)) P(s, 'error', `${rel(s.file)}:${s.line}: ${sel} (scenario ${s.id} has a design reference) has no row in ${mf}: add the region with what implements it and its source`);
  }
  const gapText = map.gaps.join('\n').toLowerCase();
  for (const r of map.rows) {
    if (!r.sourceKind) P(null, 'error', `${mf}:${r.line}: row "${r.element || r.selector}" has source "${r.source || '(empty)'}"; use token | component | framework | arbitrary (in that order of preference)`);
    if (r.sourceKind === 'arbitrary' && !/gap|because|reason|no (matching )?token/i.test(r.source + ' ' + r.notes) && !gapText.includes((r.element || '').toLowerCase()) && !gapText.includes(normSel(r.selector).toLowerCase())) P(null, 'error', `${mf}:${r.line}: "${r.element || r.selector}" maps to an arbitrary value without a gap entry; record it under "## Gaps" with the reason (no matching token) instead of inventing a value silently`);
    if (r.sourceKind === 'framework' && ds.tokens.some((t) => /colou?r|primary|brand|accent|^ui-/.test(t.name))) {
      const m = (r.impl.match(/\b(bg|text|border|ring)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/) || [])[0];
      if (m && !gapText.includes((r.element || '').toLowerCase()) && !gapText.includes(m)) P(null, 'warning', `${mf}:${r.line}: "${r.element || r.selector}" uses the framework colour ${m} although the project defines colour tokens; map it to a project token or record why under Gaps`);
    }
  }
  // Coverage: every map row is checked by the specs, text rows carry their typography, every Expect fact becomes an expect: line.
  const specExp = scens.flatMap((s) => (s.expects || []).filter((x) => !x.error));
  for (const r of map.rows) {
    const sel = normSel(r.selector); if (!sel) continue;
    const name = r.element || sel;
    const facts = mapFacts(r.notes);
    const props = new Set(facts.map((f) => f.prop));
    if (isTextRow(r)) {
      const miss = TYPO.filter((p) => !props.has(p));
      if (miss.length) P(null, 'error', `${mf}:${r.line}: text element "${name}" has no ${miss.join(', ')} in its Expect column; read ${miss.length > 1 ? 'them' : 'it'} from the design and write e.g. "${miss.map((p) => `${p} ~ ${TYPO_EX[p]}`).join('; ')}" (a token when the project has one, else the literal design value)`);
    }
    const mine = specExp.filter((x) => expectSelectors(x).map(normSel).includes(sel));
    if (!mine.length) { P(null, 'error', `${mf}:${r.line}: "${name}" (${sel}) has no expect: line in the specs; turn its Expect column into expect: lines of the visual scenario that shows it${facts.length ? '' : ' (and give the row Expect facts: typography, colour, spacing or a relation)'}`); continue; }
    for (const f of facts) if (!mine.some((x) => x.kind === 'style' && x.prop === f.prop)) P(null, 'error', `${mf}:${r.line}: the map says "${name}" ${f.prop} ${f.op} ${f.value}, but no expect: line checks ${sel} ${f.prop}; add \`expect: ${sel} ${f.prop} ${f.op} ${f.value}\` to its visual scenario`);
  }
  return problems;
}

// ---------- token lint over changed UI code ----------
const STOCK = /\b(?:[a-z]+:)*(bg|text|border|ring|outline|fill|stroke|from|via|to|divide|decoration|shadow|accent|caret|placeholder)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(50|[1-9]00|950)\b/g;
const ARBITRARY = /(?<![\w-])((?:[a-z]+:)*(?:-?[a-z][a-z0-9]*(?:-[a-z0-9]+)*))-\[([^\]\s'"`]+)\]/g;
const HEX = /(?<![\w&#-])#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
function tokenLint(codeRoot, files, ds, map) {
  const out = { errors: [], warnings: [], infos: [], counts: { arbitrary: 0, raw_hex: 0, inline: 0, stock: 0, token_equal: 0 } };
  const byNorm = new Map(); for (const t of ds.tokens) if (/^#|px$/.test(t.norm) && !byNorm.has(t.norm)) byNorm.set(t.norm, t);
  const hasColorTokens = ds.tokens.some((t) => /^color-|^ui-|^primary|^accent|^brand/.test(t.name) && (t.kind === 'tailwind-theme' || t.kind === 'design-token' || t.kind === 'ui-library' || t.kind === 'css-var'));
  const gaps = map ? (map.gaps.join('\n') + '\n' + map.rows.filter((r) => r.sourceKind === 'arbitrary').map((r) => `${r.impl} ${r.source} ${r.notes}`).join('\n')).toLowerCase() : '';
  const recorded = (s) => gaps && gaps.includes(String(s).toLowerCase());
  const use = (t) => (t.utilities && t.utilities.length ? `a ${t.utilities.slice(0, 3).join('/')} class (token --${t.name})` : `var(--${t.name})`);
  for (const f of files) {
    const abs = path.join(codeRoot, f); if (!fs.existsSync(abs)) continue;
    if (/(^|[\\/])(test|tests|__tests__|e2e)[\\/]|\.(test|spec|stories)\./.test(f)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    if (/\.(css|scss|sass|less|pcss)$/.test(f) && ds.tokens.some((t) => t.file === f)) continue; // the token files themselves
    const lineOf = (i) => text.slice(0, i).split('\n').length;
    const seen = new Set();
    const report = (sev, key, msg) => { if (seen.has(key)) return; seen.add(key); out[sev].push(msg); };
    for (const m of text.matchAll(ARBITRARY)) {
      const util = m[1]; const val = m[2].replace(/_/g, ' ');
      if (/^(data|aria|group|peer|supports|has|not|nth|in)$/.test(util.split(':').pop()) || /^(data|aria|supports|has|group|peer)-/.test(util)) continue;
      out.counts.arbitrary++;
      const t = byNorm.get(normValue(val)); const where = `${f}:${lineOf(m.index)}`;
      if (t) { out.counts.token_equal++; report('errors', `${where}${m[0]}`, `${where}: \`${m[0]}\` hard-codes ${val}, which is the project token --${t.name}: use ${use(t)}`); }
      else if (!recorded(m[0]) && !recorded(val)) report('warnings', `${where}${m[0]}`, `${where}: arbitrary value \`${m[0]}\`: map it to a project token, or record it under Gaps in design-map.md with the reason`);
    }
    for (const m of text.matchAll(HEX)) {
      const before = text.slice(Math.max(0, m.index - 40), m.index);
      if (/-\[[^\]]*$/.test(before) || /(href|src|url\()\s*=?\s*["']?[^"'\s]*$/.test(before) || /--[\w-]+\s*:\s*$/.test(before)) continue;
      out.counts.raw_hex++;
      const t = byNorm.get(normValue(m[0])); const where = `${f}:${lineOf(m.index)}`;
      if (t) { out.counts.token_equal++; report('errors', `${where}${m[0]}`, `${where}: raw colour ${m[0]} is the project token --${t.name}: use ${use(t)}`); }
      else if (hasColorTokens && !recorded(m[0])) report('warnings', `${where}${m[0]}`, `${where}: raw colour ${m[0]} although the project defines colour tokens; use a token or record the gap in design-map.md`);
    }
    for (const m of text.matchAll(/\bstyle\s*=\s*["']([^"']*(?:#[0-9a-f]{3,8}|\d+(?:\.\d+)?(?:px|rem))[^"']*)["']/gi)) { out.counts.inline++; report('warnings', `${f}:${lineOf(m.index)}style`, `${f}:${lineOf(m.index)}: inline style "${m[1].slice(0, 60)}": use the project's classes/tokens`); }
    if (hasColorTokens) for (const m of text.matchAll(STOCK)) { out.counts.stock++; if (!recorded(m[0])) report('warnings', `${f}${m[0]}`, `${f}:${lineOf(m.index)}: stock palette class \`${m[0]}\` although the project defines its own colour tokens (see \`verify-task.cjs design-system\`)`); }
  }
  return out;
}

// ---------- reviewer side-by-side (ephemeral) ----------
/** references: `reference: <path>[#x,y,w,h] [@viewports]` (repeatable). Returns { path, crop, vps, error }. */
function parseReference(v) {
  let t = String(v).trim(); let vps = null;
  const vm = t.match(/\s+@\s*((?:[<>]=?)?\s*\d+(?:\s*,\s*\d+)*)\s*$/); if (vm) { vps = parseVps(vm[1].replace(/\s+/g, '')); t = t.slice(0, vm.index).trim(); }
  let crop = null; const cm = t.match(/#(\d+),(\d+),(\d+),(\d+)$/); if (cm) { crop = { x: +cm[1], y: +cm[2], w: +cm[3], h: +cm[4] }; t = t.slice(0, cm.index); }
  return { path: t, crop, vps, error: vps && vps.error ? vps.error : null };
}
/** The reference for one viewport: an explicit @filter match, else the one whose file name carries the width, else an unfiltered one. */
function pickReference(refs, vw) {
  if (!refs || !refs.length) return null;
  return refs.find((r) => r.vps && vpMatch(r.vps, vw)) || refs.find((r) => !r.vps && new RegExp(`(^|[^0-9])${vw}([^0-9]|$)`).test(path.basename(r.path))) || refs.find((r) => !r.vps) || null;
}
async function sideBySide(browser, o) {
  const b64 = (f) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
  const ref = o.crop
    ? `<div style="width:${o.crop.w}px;height:${o.crop.h}px;overflow:hidden;position:relative"><img src="${b64(o.reference)}" style="position:absolute;left:-${o.crop.x}px;top:-${o.crop.y}px"></div>`
    : `<img src="${b64(o.reference)}">`;
  const html = `<!doctype html><html><body style="margin:0;background:#fff;font:600 13px system-ui,sans-serif;color:#111"><div style="display:flex;gap:24px;align-items:flex-start;padding:12px"><figure style="margin:0"><figcaption style="margin-bottom:6px">RENDERED: ${o.label} (after the task)</figcaption><img src="${b64(o.rendered)}" style="outline:1px solid #f0f"></figure><figure style="margin:0"><figcaption style="margin-bottom:6px">DESIGN REFERENCE: ${path.basename(o.reference)}${o.crop ? ` crop ${o.crop.x},${o.crop.y} ${o.crop.w}x${o.crop.h}` : ''}</figcaption>${ref}</figure></div></body></html>`;
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  try {
    const page = await ctx.newPage(); await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; })))));
    fs.mkdirSync(path.dirname(o.out), { recursive: true });
    await page.screenshot({ path: o.out, fullPage: true });
    return o.out;
  } finally { await ctx.close(); }
}
const RUBRIC = [
  'Design match (each scenario with a design reference). Open its side-by-side images (left: the rendered area after the task, right: the design reference) and judge each item; cite what you compared (which elements, where, what you saw on each side):',
  '  layout: arrangement, columns, order, alignment and relative sizes of the regions at this viewport.',
  '  hierarchy: what reads as most to least prominent (headings, prices, primary action, highlighted item).',
  '  spacing: gaps between and padding inside the regions follow the design rhythm (not pixel-exact).',
  '  colour: fills, text, borders and the accent/highlight use the same colours (same tokens) as the design.',
  '  typography: sizes, weights, case and letter-spacing of the text styles match the design.',
  '  components: the same kinds of components and variants (buttons, cards, badges, inputs, switches) as the design.',
  'Write one line per item and scenario: RUBRIC: <scenario id> <item>: pass|fail - <citation>. A fail also needs a DEFECT line. Not pixel-perfect: fail only what a designer would file as "does not match the design".',
];
function parseRubric(text) {
  const out = [];
  for (const l of String(text).split('\n')) {
    const m = l.match(/^\s*(?:[-*]\s*)?RUBRIC:\s*(\S+)\s+([a-z]+)\s*:\s*(pass|fail)\b\s*[-–—:]?\s*(.*)$/i);
    if (m) out.push({ scenario: m[1], item: m[2].toLowerCase().replace(/^color$/, 'colour'), verdict: m[3].toLowerCase(), cite: m[4].trim() });
  }
  return out;
}
/** Problems with a reviewer's rubric for the scenarios that need one: missing items, uncited items, fail without DEFECT. */
function rubricProblems(text, scenarioIds, status, defects) {
  if (!scenarioIds || !scenarioIds.length) return [];
  const r = parseRubric(text); const probs = [];
  for (const id of scenarioIds) for (const item of RUBRIC_ITEMS) {
    const hit = r.find((x) => x.item === item && (x.scenario === id || id.endsWith('/' + x.scenario)));
    if (!hit) probs.push(`no RUBRIC line for ${id} ${item}`);
    else if (hit.cite.split(/\s+/).filter(Boolean).length < 3) probs.push(`RUBRIC ${id} ${item} has no citation (say what you compared on each side)`);
    else if (hit.verdict === 'fail' && status === 'pass') probs.push(`RUBRIC ${id} ${item} fails but STATUS is pass`);
  }
  if (r.some((x) => x.verdict === 'fail') && !(defects || []).length) probs.push('a RUBRIC item fails but there is no DEFECT line');
  return probs;
}

module.exports = { RUBRIC_ITEMS, RUBRIC, parseExpect, expectSelectors, vpMatch, pageExpect, discover, formatDesignSystem, readDesignMap, lintDesign, tokenLint, parseReference, pickReference, sideBySide, parseRubric, rubricProblems };
