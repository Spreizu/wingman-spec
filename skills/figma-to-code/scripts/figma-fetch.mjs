#!/usr/bin/env node
// figma-fetch.mjs - dependency-free helper of the figma-to-code skill (Node >= 18, no network unless you run `fetch`).
//
//   figma-fetch.mjs parse-url <figma-url>                      file key + node id from any Figma URL form
//   figma-fetch.mjs fetch <figma-url> [--out DIR] [--refresh] [--depth N] [--assets] [--screenshot] [--scale N]
//                                                              REST: node JSON (+ variables, exports); needs FIGMA_TOKEN
//   figma-fetch.mjs normalise <raw.json|-> [--node ID] [--variables FILE] [--collapse-instances] [--max-depth N]
//                                                              raw REST nodes/file response -> compact layout/style JSON
//   figma-fetch.mjs facts <normalised.json> [--design-system FILE] [--at WIDTH] [--tailwind 3|4]
//                                                              per-node design facts, each mapped token > stock > arbitrary
//   figma-fetch.mjs diff <facts.json> <code-values.json> [--md]   Figma value vs current code value, per node and property
//
// The token is read ONLY from the FIGMA_TOKEN environment variable, sent as the X-Figma-Token header, and never printed,
// written to a file or put on a command line. Every message passes through redact().
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class FigmaError extends Error {
  constructor(message, code = 1) { super(message); this.name = 'FigmaError'; this.code = code; }
}
export const EXIT = { OK: 0, FAIL: 1, USAGE: 2, NO_TOKEN: 3, HTTP: 4, RATE: 5 };

/** Remove the token (and anything that looks like a Figma token) from text before it is shown or stored. */
export function redact(text, env = process.env) {
  let s = String(text ?? '');
  const t = env.FIGMA_TOKEN;
  if (t && t.length >= 4) s = s.split(t).join('[redacted]');
  return s.replace(/\bfig[a-z]?_[A-Za-z0-9_-]{16,}/g, '[redacted]');
}

// ---------------------------------------------------------------------------------------------- URL parsing
const KINDS = { design: 'design', file: 'design', proto: 'prototype', board: 'figjam', slides: 'slides', deck: 'slides', make: 'make', buzz: 'buzz' };

/** Convert a node id from URL form (1-2, 1%3A2, I5:6-1:2 ...) to API form (1:2). */
export function normaliseNodeId(id) {
  if (id == null) return null;
  let s = String(id).trim();
  try { s = decodeURIComponent(s); } catch { /* keep as is */ }
  if (!s) return null;
  s = s.replace(/-/g, ':');
  if (!/^I?\d+:\d+(?:;I?\d+:\d+)*$/.test(s)) throw new FigmaError(`"${id}" is not a Figma node id (expected like 12-34 or 12:34)`, EXIT.USAGE);
  return s;
}

/**
 * Parse any Figma link. Returns { fileKey, nodeId, kind, branch, mainFileKey, name, warnings }.
 * Branch URLs (/design/<main>/branch/<branchKey>/<name>) use the branch key as the file key.
 */
export function parseFigmaUrl(input) {
  let raw = String(input ?? '').trim().replace(/^<|>$/g, '').replace(/^["']|["']$/g, '');
  if (!raw) throw new FigmaError('no Figma URL given', EXIT.USAGE);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw.replace(/^\/+/, '');
  let u;
  try { u = new URL(raw); } catch { throw new FigmaError(`not a URL: ${redact(raw).slice(0, 80)}`, EXIT.USAGE); }
  const host = u.hostname.toLowerCase();
  if (host !== 'figma.com' && !host.endsWith('.figma.com')) throw new FigmaError(`not a figma.com URL (host ${host})`, EXIT.USAGE);
  // embed.figma.com/... and figma.com/embed?embed_host=..&url=<real link>
  const inner = u.searchParams.get('url');
  if (u.pathname.replace(/\/$/, '') === '/embed' && inner) return parseFigmaUrl(inner);
  const seg = u.pathname.split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
  const warnings = [];
  const kindWord = seg[0];
  if (!KINDS[kindWord]) throw new FigmaError(`unrecognised Figma link path "/${seg.slice(0, 2).join('/')}": expected /design/<key>/..., /file/<key>/..., /proto/<key>/... or /board/<key>/...`, EXIT.USAGE);
  const kind = KINDS[kindWord];
  let fileKey = seg[1];
  if (!fileKey || !/^[A-Za-z0-9]+$/.test(fileKey)) throw new FigmaError('the link has no file key (expected figma.com/design/<fileKey>/<name>)', EXIT.USAGE);
  let branch = false, mainFileKey = null, name = seg[2] || null;
  if (seg[2] === 'branch' && seg[3]) { branch = true; mainFileKey = fileKey; fileKey = seg[3]; name = seg[4] || null; }
  if (!/^[A-Za-z0-9]+$/.test(fileKey)) throw new FigmaError('the branch key in the link is not valid', EXIT.USAGE);
  let nodeId = null;
  const q = u.searchParams.get('node-id') ?? u.searchParams.get('starting-point-node-id');
  if (q) nodeId = normaliseNodeId(q);
  if (kind === 'figjam') warnings.push('FigJam boards hold diagrams and stickies, not UI designs: ask for a link to a design frame');
  if (kind === 'prototype') warnings.push('prototype link: the node-id is the frame shown first; check it is the frame to build');
  if (kind === 'slides' || kind === 'make' || kind === 'buzz') warnings.push(`a Figma ${kindWord} file is not a UI design: ask for a design frame link`);
  if (!nodeId) warnings.push('no node-id in the link: it points to a whole file/page. Ask for a link to the frame to build (right-click the frame, Copy link to selection)');
  return { fileKey, nodeId, kind, branch, mainFileKey, name, warnings };
}

// ---------------------------------------------------------------------------------------------- normaliser
const r2 = (n) => Math.round(n * 100) / 100;
const hex2 = (n) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0');

/** Figma colour {r,g,b,a: 0..1} (+ paint opacity) -> #rrggbb, or #rrggbbaa when translucent. */
export function toHex(c, opacity = 1) {
  if (!c) return null;
  const a = (c.a ?? 1) * (opacity ?? 1);
  return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b) + (a < 0.995 ? hex2(a) : '');
}

const JUSTIFY = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between' };
const ALIGN = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline' };
const TEXT_ALIGN = { LEFT: 'left', RIGHT: 'right', CENTER: 'center', JUSTIFIED: 'justify' };
const TEXT_CASE = { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize', SMALL_CAPS: 'small-caps', SMALL_CAPS_FORCED: 'small-caps' };
const VECTOR_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'LINE', 'ELLIPSE', 'REGULAR_POLYGON']);

const visibleList = (a) => (Array.isArray(a) ? a.filter((p) => p && p.visible !== false) : []);

function paintOf(p, boundIds) {
  if (p.type === 'SOLID') { const o = { color: toHex(p.color, p.opacity) }; if (p.boundVariables?.color?.id) boundIds.push(p.boundVariables.color.id); return o; }
  if (p.type === 'IMAGE') return { image: p.imageRef || true, scaleMode: (p.scaleMode || 'FILL').toLowerCase() };
  if (String(p.type).startsWith('GRADIENT_')) return { gradient: p.type.slice(9).toLowerCase(), stops: (p.gradientStops || []).map((s) => ({ at: r2(s.position), color: toHex(s.color, p.opacity) })) };
  return { unsupported: p.type };
}

function lineHeightPx(style) {
  if (style.lineHeightUnit === 'INTRINSIC_%' || (style.lineHeightPx == null && style.lineHeightPercentFontSize == null)) return { auto: true, px: style.lineHeightPx != null ? r2(style.lineHeightPx) : null };
  return { auto: false, px: style.lineHeightPx != null ? r2(style.lineHeightPx) : r2((style.lineHeightPercentFontSize / 100) * style.fontSize) };
}

function parseVariantName(name) {
  if (!name || !name.includes('=')) return null;
  const out = {};
  for (const part of name.split(',')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return Object.keys(out).length ? out : null;
}

/**
 * Normalise one REST node (and its subtree). ctx: { styles, components, componentSets, opts, warnings, stats, bound }.
 * `parent` is the already-normalised parent frame info { auto: boolean, box, dir } used for sizing and position.
 */
function normNode(n, parent, ctx, depth) {
  if (n.visible === false) { ctx.stats.hidden++; return null; }
  ctx.stats.nodes++;
  const out = { id: n.id, name: n.name, type: n.type };
  const box = n.absoluteBoundingBox;
  if (box) out.box = { w: r2(box.width), h: r2(box.height) };
  const bound = [];

  // ---- role
  const hasImageFill = visibleList(n.fills).some((p) => p.type === 'IMAGE');
  if (n.type === 'TEXT') out.role = 'text';
  else if (VECTOR_TYPES.has(n.type)) out.role = box && Math.max(box.width, box.height) <= 64 ? 'icon' : 'vector';
  else if (hasImageFill) out.role = 'image';
  else if (n.type === 'INSTANCE') out.role = 'instance';
  else if (n.type === 'COMPONENT_SET') out.role = 'component-set';
  else if (n.type === 'COMPONENT') out.role = 'component';
  else out.role = 'frame';
  if (n.type === 'INSTANCE' && /^(icon|icons|ic)\b[ /_-]?/i.test(n.name) && box && Math.max(box.width, box.height) <= 64) out.role = 'icon';

  // ---- component / variant info
  if (n.type === 'INSTANCE' && n.componentId) {
    const c = ctx.components[n.componentId] || {};
    const set = c.componentSetId ? ctx.componentSets[c.componentSetId] : null;
    out.component = { id: n.componentId, name: c.name || null };
    if (set?.name) out.component.set = set.name;
    const variant = parseVariantName(c.name);
    if (variant) out.component.variant = variant;
    const props = {};
    for (const [k, v] of Object.entries(n.componentProperties || {})) props[k.replace(/#\d+:\d+$/, '')] = v && typeof v === 'object' && 'value' in v ? v.value : v;
    if (Object.keys(props).length) out.component.props = props;
    if (!c.name) ctx.warnings.push(`instance "${n.name}" (${n.id}): its component is not in the response (remote library?); use the layer name`);
  }
  if (n.type === 'COMPONENT' && parseVariantName(n.name)) out.variant = parseVariantName(n.name);
  if (n.type === 'COMPONENT_SET' && n.name) out.component = { name: n.name };

  // ---- own layout (auto layout) and sizing inside the parent
  const auto = n.layoutMode && n.layoutMode !== 'NONE';
  if (auto && n.layoutMode !== 'GRID') {
    const dir = n.layoutMode === 'HORIZONTAL' ? 'row' : 'column';
    const l = { display: 'flex', direction: dir };
    if (n.itemSpacing) l.gap = r2(n.itemSpacing);
    if (n.layoutWrap === 'WRAP') { l.wrap = true; if (n.counterAxisSpacing != null) l.crossGap = r2(n.counterAxisSpacing); }
    const pad = [n.paddingTop || 0, n.paddingRight || 0, n.paddingBottom || 0, n.paddingLeft || 0].map(r2);
    if (pad.some(Boolean)) l.padding = { t: pad[0], r: pad[1], b: pad[2], l: pad[3] };
    if (n.primaryAxisAlignItems && n.primaryAxisAlignItems !== 'MIN') l.justify = JUSTIFY[n.primaryAxisAlignItems];
    if (n.counterAxisAlignItems && n.counterAxisAlignItems !== 'MIN') l.align = ALIGN[n.counterAxisAlignItems];
    if (n.itemSpacing && n.primaryAxisAlignItems === 'SPACE_BETWEEN') { l.minGap = l.gap; delete l.gap; }
    out.layout = l;
  } else if (auto) {
    const l = { display: 'grid' };
    for (const [k, f] of [['columns', 'gridColumnCount'], ['rows', 'gridRowCount'], ['columnGap', 'gridColumnGap'], ['rowGap', 'gridRowGap']]) if (n[f]) l[k] = n[f];
    const pad = [n.paddingTop || 0, n.paddingRight || 0, n.paddingBottom || 0, n.paddingLeft || 0].map(r2);
    if (pad.some(Boolean)) l.padding = { t: pad[0], r: pad[1], b: pad[2], l: pad[3] };
    out.layout = l;
  } else if ((n.children || []).filter((c) => c.visible !== false).length > 1 && ['FRAME', 'COMPONENT', 'INSTANCE', 'GROUP', 'SECTION'].includes(n.type)) {
    out.layout = { display: 'none', note: 'no auto layout: infer flex/grid from the child positions, never absolute positioning' };
    ctx.warnings.push(`${n.type} "${n.name}" (${n.id}) has no auto layout: layout must be inferred from positions (children carry pos)`);
  }

  // sizing of this node in its parent
  const size = {};
  const hz = n.layoutSizingHorizontal, vt = n.layoutSizingVertical;
  const dirOf = parent?.dir;
  const fill = (axisIsPrimary) => (axisIsPrimary ? n.layoutGrow === 1 : n.layoutAlign === 'STRETCH');
  const sz = (mode, isW) => {
    if (mode === 'FILL') return 'fill';
    if (mode === 'HUG') return 'hug';
    if (mode === 'FIXED') return box ? r2(isW ? box.width : box.height) : 'fixed';
    return undefined;
  };
  let w = sz(hz, true), h = sz(vt, false);
  if (w === undefined && parent?.auto && dirOf) { if (fill(dirOf === 'row')) w = 'fill'; }
  if (h === undefined && parent?.auto && dirOf) { if (fill(dirOf === 'column')) h = 'fill'; }
  if (w === undefined && box && !(out.role === 'text')) w = r2(box.width);
  if (h === undefined && box && !(out.role === 'text')) h = r2(box.height);
  if (w !== undefined) size.w = w;
  if (h !== undefined) size.h = h;
  for (const [k, f] of [['minW', 'minWidth'], ['maxW', 'maxWidth'], ['minH', 'minHeight'], ['maxH', 'maxHeight']]) if (n[f]) size[k] = r2(n[f]);
  if (Object.keys(size).length) out.size = size;
  if (parent?.auto && n.layoutAlign && !['INHERIT', 'STRETCH'].includes(n.layoutAlign)) out.alignSelf = ALIGN[n.layoutAlign];
  if (n.layoutGrow === 1) out.grow = 1;
  if (n.layoutPositioning === 'ABSOLUTE') { out.absolute = true; ctx.warnings.push(`"${n.name}" (${n.id}) is absolutely positioned inside an auto-layout frame (badge/overlay): position it against its parent, not the page`); }
  if (parent && !parent.auto && parent.box && box) {
    out.pos = { x: r2(box.x - parent.box.x), y: r2(box.y - parent.box.y) };
    const c = n.constraints;
    if (c && (c.horizontal !== 'LEFT' || c.vertical !== 'TOP')) out.constraints = { h: c.horizontal, v: c.vertical };
  }
  if (parent?.auto && n.layoutPositioning === 'ABSOLUTE' && parent.box && box) out.pos = { x: r2(box.x - parent.box.x), y: r2(box.y - parent.box.y) };

  // ---- paints
  const fills = visibleList(n.fills);
  if (n.type === 'TEXT') {
    const solid = fills.find((p) => p.type === 'SOLID');
    if (fills.length > 1 || (fills[0] && fills[0].type !== 'SOLID')) ctx.warnings.push(`text "${n.name}" (${n.id}) has a gradient/multiple fills: only the first solid colour is reported`);
    if (solid) { out.color = toHex(solid.color, solid.opacity); if (solid.boundVariables?.color?.id) bound.push(['color', solid.boundVariables.color.id]); }
  } else if (fills.length === 1 && fills[0].type === 'SOLID') {
    out.fill = toHex(fills[0].color, fills[0].opacity);
    if (fills[0].boundVariables?.color?.id) bound.push(['fill', fills[0].boundVariables.color.id]);
  } else if (fills.length) {
    const ids = []; out.fills = fills.map((p) => paintOf(p, ids));
    if (hasImageFill) out.image = fills.find((p) => p.type === 'IMAGE')?.imageRef || true;
  }
  const strokes = visibleList(n.strokes);
  if (strokes.length && (n.strokeWeight || n.individualStrokeWeights) && n.type !== 'TEXT') {
    const s = { color: strokes[0].type === 'SOLID' ? toHex(strokes[0].color, strokes[0].opacity) : strokes[0].type, align: (n.strokeAlign || 'INSIDE').toLowerCase() };
    if (strokes[0].boundVariables?.color?.id) bound.push(['stroke', strokes[0].boundVariables.color.id]);
    if (n.individualStrokeWeights) { const w4 = n.individualStrokeWeights; s.weights = { t: w4.top, r: w4.right, b: w4.bottom, l: w4.left }; }
    else s.weight = r2(n.strokeWeight);
    if (n.strokeDashes?.length) s.dashed = true;
    out.stroke = s;
  }
  if (n.rectangleCornerRadii && new Set(n.rectangleCornerRadii).size > 1) out.radius = n.rectangleCornerRadii.map(r2);
  else if (n.cornerRadius) out.radius = r2(n.cornerRadius);
  else if (n.rectangleCornerRadii?.[0]) out.radius = r2(n.rectangleCornerRadii[0]);
  const effects = visibleList(n.effects);
  const shadows = effects.filter((e) => e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW').map((e) => ({ type: e.type === 'INNER_SHADOW' ? 'inner' : 'drop', x: r2(e.offset?.x || 0), y: r2(e.offset?.y || 0), blur: r2(e.radius || 0), spread: r2(e.spread || 0), color: toHex(e.color) }));
  if (shadows.length) out.shadow = shadows;
  const blur = effects.filter((e) => e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR').map((e) => ({ type: e.type === 'LAYER_BLUR' ? 'blur' : 'backdrop-blur', radius: r2(e.radius || 0) }));
  if (blur.length) out.blur = blur;
  if (n.opacity != null && n.opacity < 1) out.opacity = r2(n.opacity);
  if (n.clipsContent && (out.layout || out.radius)) out.clip = true;
  if (n.rotation) { out.rotation = r2(n.rotation * 180 / Math.PI); ctx.warnings.push(`"${n.name}" (${n.id}) is rotated`); }

  // ---- text
  if (n.type === 'TEXT') {
    const st = n.style || {};
    const lh = lineHeightPx(st);
    const t = { chars: n.characters ?? '', family: st.fontFamily, size: st.fontSize, weight: st.fontWeight, lineHeight: lh.px };
    if (lh.auto) t.lineHeightAuto = true;
    if (st.letterSpacing) t.letterSpacing = r2(st.letterSpacing);
    if (st.textAlignHorizontal && st.textAlignHorizontal !== 'LEFT') t.align = TEXT_ALIGN[st.textAlignHorizontal];
    if (st.textCase && TEXT_CASE[st.textCase]) t.transform = TEXT_CASE[st.textCase];
    if (st.textDecoration && st.textDecoration !== 'NONE') t.decoration = st.textDecoration === 'UNDERLINE' ? 'underline' : 'line-through';
    if (st.italic) t.italic = true;
    if (st.textTruncation === 'ENDING') t.truncate = st.maxLines || 1;
    if (st.textAutoResize === 'WIDTH_AND_HEIGHT') t.nowrap = true;
    out.text = t;
    if (n.characterStyleOverrides?.some((x) => x !== 0) && Object.keys(n.styleOverrideTable || {}).length) ctx.warnings.push(`text "${n.name}" (${n.id}) mixes styles (spans): build it with inline elements`);
    for (const k of ['fontSize', 'fontWeight', 'lineHeight']) { const id = st.boundVariables?.[k]?.id || (Array.isArray(st.boundVariables?.[k]) ? st.boundVariables[k][0]?.id : null); if (id) bound.push([k === 'lineHeight' ? 'lineHeight' : k, id]); }
  }

  // ---- bound variables on the node itself (spacing, radius ...)
  for (const [k, v] of Object.entries(n.boundVariables || {})) {
    const id = Array.isArray(v) ? v[0]?.id : v?.id;
    if (id && !['fills', 'strokes', 'effects'].includes(k)) bound.push([k, id]);
  }
  if (bound.length) { out.bound = {}; for (const [k, id] of bound) { out.bound[k] = id; ctx.bound.add(id); } }

  // ---- named styles (text/fill styles the designer applied)
  if (n.styles) {
    const sr = {};
    for (const [k, id] of Object.entries(n.styles)) { const s = ctx.styles[id]; sr[k] = s?.name || id; }
    if (Object.keys(sr).length) out.styles = sr;
  }

  // ---- children
  const kids = (n.children || []);
  if (kids.length) {
    const collapse = ctx.opts.collapseInstances && n.type === 'INSTANCE';
    if (collapse) {
      const texts = []; const walk = (x) => { if (x.visible === false) return; if (x.type === 'TEXT' && x.characters) texts.push(x.characters); (x.children || []).forEach(walk); };
      kids.forEach(walk); if (texts.length) out.texts = texts;
      ctx.stats.collapsed++;
    } else if (ctx.opts.maxDepth != null && depth >= ctx.opts.maxDepth) {
      out.truncated = kids.length;
    } else {
      const me = { auto: !!(auto && n.layoutMode !== 'GRID') || n.layoutMode === 'GRID', box, dir: n.layoutMode === 'HORIZONTAL' ? 'row' : n.layoutMode === 'VERTICAL' ? 'column' : null };
      const c = kids.map((k) => normNode(k, me, ctx, depth + 1)).filter(Boolean);
      if (c.length) out.children = c;
    }
  }
  return out;
}

function pickVariableValue(v, modeId) {
  if (v && typeof v === 'object' && v.type === 'VARIABLE_ALIAS') return { alias: v.id };
  if (v && typeof v === 'object' && 'r' in v) return toHex(v);
  return v;
}

/** Normalise GET /v1/files/:key/variables/local -> { id: { name, type, collection, modes: {modeName: value}, web } } */
export function normaliseVariables(resp) {
  const meta = resp?.meta || resp || {};
  const cols = meta.variableCollections || {};
  const out = {};
  for (const [id, v] of Object.entries(meta.variables || {})) {
    const col = cols[v.variableCollectionId] || {};
    const names = Object.fromEntries((col.modes || []).map((m) => [m.modeId, m.name]));
    const values = {};
    for (const [mid, val] of Object.entries(v.valuesByMode || {})) values[names[mid] || mid] = pickVariableValue(val, mid);
    const e = { name: v.name, type: v.resolvedType, collection: col.name || null, values };
    if (col.defaultModeId && names[col.defaultModeId]) e.defaultMode = names[col.defaultModeId];
    if (v.codeSyntax?.WEB) e.web = v.codeSyntax.WEB;
    out[id] = e;
  }
  // resolve aliases one level deep for display
  for (const e of Object.values(out)) for (const [m, val] of Object.entries(e.values)) if (val && val.alias && out[val.alias]) { e.values[m] = { alias: out[val.alias].name, value: out[val.alias].values[m] ?? out[val.alias].values[out[val.alias].defaultMode] }; }
  return out;
}

/**
 * Normalise a raw REST response: GET /v1/files/:key/nodes (one or more nodes), GET /v1/files/:key, or a bare node.
 * opts: { nodeId, variables (raw variables response or normalised map), collapseInstances, maxDepth }
 */
export function normalise(raw, opts = {}) {
  const warnings = [];
  const stats = { nodes: 0, hidden: 0, collapsed: 0 };
  let entries = [];
  if (raw && raw.nodes && typeof raw.nodes === 'object' && !Array.isArray(raw.nodes)) {
    for (const [id, e] of Object.entries(raw.nodes)) { if (!e) { warnings.push(`node ${id} is not in the file (deleted, or the link is stale)`); continue; } entries.push({ id, doc: e.document, components: e.components || {}, componentSets: e.componentSets || {}, styles: e.styles || {} }); }
  } else if (raw && raw.document) {
    const pages = raw.document.children || [];
    const want = opts.nodeId;
    const find = (n) => { if (n.id === want) return n; for (const c of n.children || []) { const f = find(c); if (f) return f; } return null; };
    const doc = want ? find(raw.document) : null;
    if (want && !doc) throw new FigmaError(`node ${want} not found in the file response`, EXIT.USAGE);
    if (!want && pages.length > 1) warnings.push(`file has ${pages.length} pages; reporting the first page, pass a node id`);
    entries.push({ id: (doc || pages[0] || raw.document).id, doc: doc || pages[0] || raw.document, components: raw.components || {}, componentSets: raw.componentSets || {}, styles: raw.styles || {} });
  } else if (raw && raw.type && raw.id) {
    entries.push({ id: raw.id, doc: raw, components: {}, componentSets: {}, styles: {} });
  } else throw new FigmaError('input is not a Figma REST response (expected the JSON of GET /v1/files/:key/nodes or /v1/files/:key)', EXIT.USAGE);
  if (opts.nodeId) { const hit = entries.filter((e) => e.id === opts.nodeId); if (hit.length) entries = hit; }
  const bound = new Set();
  const roots = entries.map((e) => {
    const ctx = { styles: e.styles, components: e.components, componentSets: e.componentSets, opts, warnings, stats, bound };
    const r = normNode(e.doc, null, ctx, 0);
    return r;
  }).filter(Boolean);
  const variables = opts.variables ? (opts.variables.meta || opts.variables.variables ? normaliseVariables(opts.variables) : opts.variables) : null;
  if (!variables && bound.size) warnings.push(`${bound.size} value(s) are bound to Figma variables but no variables were loaded (needs the MCP get_variable_defs, or REST variables on an Enterprise plan): names fall back to styles and values`);
  const result = {
    source: { fileKey: opts.fileKey || null, name: raw.name || null, version: raw.version || null, lastModified: raw.lastModified || null, via: opts.via || 'rest' },
    root: roots.length === 1 ? roots[0] : null,
    roots: roots.length === 1 ? undefined : roots,
    variables: variables ? Object.fromEntries([...bound].filter((id) => variables[id]).map((id) => [id, variables[id]])) : null,
    stats, warnings,
  };
  if (!result.roots) delete result.roots;
  return result;
}

// ---------------------------------------------------------------------------------------------- facts + mapping
const FONT_SIZES = { 12: 'xs', 14: 'sm', 16: 'base', 18: 'lg', 20: 'xl', 24: '2xl', 30: '3xl', 36: '4xl', 48: '5xl', 60: '6xl', 72: '7xl', 96: '8xl', 128: '9xl' };
const WEIGHTS = { 100: 'thin', 200: 'extralight', 300: 'light', 400: 'normal', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'extrabold', 900: 'black' };
const LEADING = [[1, 'none'], [1.25, 'tight'], [1.375, 'snug'], [1.5, 'normal'], [1.625, 'relaxed'], [2, 'loose']];
const TRACKING = [[-0.05, 'tighter'], [-0.025, 'tight'], [0, 'normal'], [0.025, 'wide'], [0.05, 'wider'], [0.1, 'widest']];
const RADII4 = { 2: 'xs', 4: 'sm', 6: 'md', 8: 'lg', 12: 'xl', 16: '2xl', 24: '3xl', 32: '4xl' };
const RADII3 = { 2: 'sm', 4: '', 6: 'md', 8: 'lg', 12: 'xl', 16: '2xl', 24: '3xl' };
const SPACING3 = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96];
const num = (x) => String(r2(x));

/** "1.75rem" | "14px" | 14 -> px number, else null. */
export function lengthPx(v) {
  if (typeof v === 'number') return v;
  const m = String(v ?? '').trim().match(/^(-?\d*\.?\d+)(px|rem|em)?$/);
  if (!m) return null;
  return m[2] === 'rem' || m[2] === 'em' ? parseFloat(m[1]) * 16 : parseFloat(m[1]);
}
/** #rgb|#rrggbb|#rrggbbaa|rgb()/rgba() -> [r,g,b,a] or null. */
export function parseColor(v) {
  const s = String(v ?? '').trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3})$/); if (m) return [...m[1]].map((c) => parseInt(c + c, 16)).concat(1);
  m = s.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/); if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(m[2] ? parseInt(m[2], 16) / 255 : 1);
  m = s.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (m) { let a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]); return [+m[1], +m[2], +m[3], a]; }
  return null;
}
const colorDist = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]), Math.abs(a[3] - b[3]) * 255);

function spacingClass(px, tw) {
  if (px === 0) return '0';
  if (px === 1) return 'px';
  const n = px / 4;
  if (tw >= 4 ? px % 2 === 0 && px > 0 : SPACING3.includes(n)) return String(n);
  return null;
}

/** Tailwind stock utility for a value, or null when the value is off the stock scale. */
function stockClass(prop, px, ctx) {
  const tw = ctx.tw;
  switch (prop) {
    case 'font-size': return FONT_SIZES[px] ? `text-${FONT_SIZES[px]}` : null;
    case 'font-weight': return WEIGHTS[px] ? `font-${WEIGHTS[px]}` : null;
    case 'line-height': {
      if (!ctx.fontSize) return null;
      const ratio = px / ctx.fontSize;
      const l = LEADING.find(([r]) => Math.abs(r - ratio) < 0.006); if (l) return `leading-${l[1]}`;
      const n = px % 4 === 0 ? px / 4 : null; return n ? `leading-${n}` : null;
    }
    case 'letter-spacing': {
      if (!ctx.fontSize) return null; const em = px / ctx.fontSize;
      const t = TRACKING.find(([r]) => Math.abs(r - em) < 0.004); return t ? `tracking-${t[1]}` : null;
    }
    case 'gap': case 'row-gap': case 'column-gap': { const s = spacingClass(px, tw); const p = prop === 'gap' ? 'gap' : prop === 'row-gap' ? 'gap-y' : 'gap-x'; return s == null ? null : `${p}-${s}`; }
    case 'padding': case 'padding-top': case 'padding-right': case 'padding-bottom': case 'padding-left': {
      const s = spacingClass(px, tw); const p = { padding: 'p', 'padding-top': 'pt', 'padding-right': 'pr', 'padding-bottom': 'pb', 'padding-left': 'pl' }[prop]; return s == null ? null : `${p}-${s}`;
    }
    case 'width': case 'height': { const s = spacingClass(px, tw); return s == null ? null : `${prop === 'width' ? 'w' : 'h'}-${s}`; } // fixed icon/image sizes: the spacing scale
    case 'border-width': return { 0: 'border-0', 1: 'border', 2: 'border-2', 4: 'border-4', 8: 'border-8' }[px] || null;
    case 'border-radius': {
      if (px >= 9999) return 'rounded-full';
      const t = (tw >= 4 ? RADII4 : RADII3)[px]; if (t === undefined) return null; return t ? `rounded-${t}` : 'rounded';
    }
    default: return null;
  }
}
const arbClass = (prop, v) => ({ 'font-size': `text-[${v}]`, 'font-weight': `font-[${v}]`, 'line-height': `leading-[${v}]`, 'letter-spacing': `tracking-[${v}]`, gap: `gap-[${v}]`, 'row-gap': `gap-y-[${v}]`, 'column-gap': `gap-x-[${v}]`, padding: `p-[${v}]`, 'padding-top': `pt-[${v}]`, 'padding-right': `pr-[${v}]`, 'padding-bottom': `pb-[${v}]`, 'padding-left': `pl-[${v}]`, 'border-radius': `rounded-[${v}]`, 'background-color': `bg-[${v}]`, color: `text-[${v}]`, 'border-color': `border-[${v}]`, 'border-width': `border-[${v}]`, width: `w-[${v}]`, height: `h-[${v}]` })[prop] || null;

/** Index the project's tokens (verify-task.cjs design-system --format json) by what they can express. */
export function indexTokens(ds) {
  const idx = { colors: [], spacing: [], radius: [], fontSize: [], weight: [], shadow: [], leading: {}, tailwind: ds?.tailwind?.version ?? null };
  for (const t of ds?.tokens || []) {
    const name = t.name, value = String(t.value);
    if (/--line-height$/.test(name)) { idx.leading[name.replace(/--line-height$/, '')] = parseFloat(value); continue; }
    const tw = t.kind === 'tailwind-theme';
    const tail = (ns) => (tw && name.startsWith(ns + '-') ? name.slice(ns.length + 1) : null);
    const e = { name, value, tw, file: t.file };
    const col = parseColor(value);
    if (col && (tw ? name.startsWith('color-') : /colou?r|bg|fg|surface|brand|primary|border|text/.test(name) || true)) { idx.colors.push({ ...e, rgb: col, tail: tail('color') }); continue; }
    if (/shadow/.test(name)) { idx.shadow.push({ ...e, tail: tail('shadow') }); continue; }
    const px = lengthPx(value);
    if (/weight/.test(name) && /^\d+$/.test(value)) { idx.weight.push({ ...e, px: +value, tail: tail('font-weight') }); continue; }
    if (px == null) continue;
    if (/radius|rounded/.test(name)) idx.radius.push({ ...e, px, tail: tail('radius') });
    else if (/^text-|font-?size|^fs-|^size-text/.test(name)) idx.fontSize.push({ ...e, px, tail: tail('text'), lh: idx.leading[name] });
    else if (/spacing|space|gap|pad|gutter|inset/.test(name)) idx.spacing.push({ ...e, px, tail: tail('spacing') });
  }
  for (const f of idx.fontSize) f.lh = idx.leading[f.name];
  return idx;
}

/** "0 1px 2px rgb(16 24 40 / 0.06), inset 0 0 4px #00000033" -> [{ inset, n: [x,y,blur,spread], c: [r,g,b,a] }] or null. */
export function canonShadow(v) {
  const parts = []; let depth = 0, cur = '';
  for (const ch of String(v)) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && !depth) { parts.push(cur); cur = ''; } else cur += ch; }
  parts.push(cur);
  const out = [];
  for (const part of parts) {
    let t = part.trim(); const inset = /^inset\b|\binset$/.test(t); t = t.replace(/\binset\b/, '').trim();
    const cm = t.match(/(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/); if (!cm) return null;
    const c = parseColor(cm[1].replace(/\s*\/\s*/, ' ').replace(/(\d)\s+(?=[\d.]+%?\))/g, '$1, ')); if (!c) return null;
    const lens = t.replace(cm[1], ' ').trim().split(/\s+/).filter(Boolean).map(lengthPx); if (lens.length < 2 || lens.some((x) => x == null)) return null;
    out.push({ inset, n: [lens[0], lens[1], lens[2] ?? 0, lens[3] ?? 0], c });
  }
  return out;
}
const slugName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function hintMatches(tok, hint) {
  if (!hint) return false;
  const h = slugName(hint), last = slugName(String(hint).split('/').pop());
  return tok.name === h || tok.name.endsWith('-' + last) || tok.name === last || (tok.tail && (tok.tail === last || h.endsWith(tok.tail)));
}
function tokenClass(prop, tok) {
  if (!tok.tw || !tok.tail) return `[var(--${tok.name})]`;
  const p = { gap: 'gap', 'row-gap': 'gap-y', 'column-gap': 'gap-x', padding: 'p', 'padding-top': 'pt', 'padding-right': 'pr', 'padding-bottom': 'pb', 'padding-left': 'pl', 'border-radius': 'rounded', 'font-size': 'text', 'font-weight': 'font', color: 'text', 'background-color': 'bg', 'border-color': 'border', 'box-shadow': 'shadow' }[prop];
  return p ? `${p}-${tok.tail}` : null;
}

/** Decide how one value is implemented: token > stock Tailwind > arbitrary. */
function mapValue(prop, cssValue, ctx) {
  const idx = ctx.tokens;
  const group = { 'background-color': 'colors', color: 'colors', 'border-color': 'colors', gap: 'spacing', 'row-gap': 'spacing', 'column-gap': 'spacing', padding: 'spacing', 'padding-top': 'spacing', 'padding-right': 'spacing', 'padding-bottom': 'spacing', 'padding-left': 'spacing', 'border-radius': 'radius', 'font-size': 'fontSize', 'font-weight': 'weight', 'box-shadow': 'shadow' }[prop];
  let cands = [], drift = null;
  if (idx && group) {
    const list = idx[group];
    if (group === 'colors') {
      const want = parseColor(cssValue);
      const hinted = ctx.hint ? list.find((t) => hintMatches(t, ctx.hint)) : null;
      if (hinted && want && colorDist(hinted.rgb, want) > 3) drift = `the Figma variable/style "${ctx.hint}" matches token --${hinted.name} (${hinted.value}) but Figma has ${cssValue}`;
      if (want) cands = list.filter((t) => colorDist(t.rgb, want) === 0);
      if (!cands.length && want) cands = list.filter((t) => colorDist(t.rgb, want) <= 3).map((t) => ({ ...t, near: true }));
      if (hinted && drift) cands = [hinted, ...cands.filter((t) => t !== hinted)];
    } else if (group === 'shadow') {
      const want = canonShadow(cssValue);
      cands = want ? list.filter((t) => { const g = canonShadow(t.value); return g && g.length === want.length && g.every((x, i) => x.inset === want[i].inset && x.n.every((v, j) => Math.abs(v - want[i].n[j]) < 0.01) && colorDist(x.c, want[i].c) <= 1); }) : [];
    } else {
      const px = lengthPx(cssValue);
      if (px != null) {
        cands = list.filter((t) => Math.abs(t.px - px) < 0.01);
        if (ctx.hint) { const h = list.find((t) => hintMatches(t, ctx.hint)); if (h && Math.abs(h.px - px) >= 0.01) drift = `the Figma variable/style "${ctx.hint}" matches token --${h.name} (${h.value}) but Figma has ${cssValue}`; if (h) cands = [h, ...cands.filter((t) => t !== h)]; }
      }
    }
  }
  const px = group === 'colors' || group === 'shadow' ? null : lengthPx(cssValue);
  if (cands.length) {
    const t = cands[0];
    const o = { via: 'token', ref: t.name, class: tokenClass(prop, t), expect: `token:${t.name}` };
    if (t.near) o.near = true;
    if (drift) { o.drift = drift; o.expect = cssValue; }
    if (cands.length > 1) o.alternatives = cands.slice(1, 4).map((x) => x.name);
    return o;
  }
  if (px != null && !['font-weight'].includes(prop) || prop === 'font-weight') {
    const v = prop === 'font-weight' ? +cssValue : px;
    const c = stockClass(prop, v, ctx);
    if (c) return { via: 'framework', class: c, expect: cssValue };
  }
  if (prop === 'background-color' || prop === 'color' || prop === 'border-color') {
    const c = parseColor(cssValue);
    if (c && c[3] === 1 && c[0] === 255 && c[1] === 255 && c[2] === 255) return { via: 'framework', class: prop === 'background-color' ? 'bg-white' : prop === 'color' ? 'text-white' : 'border-white', expect: cssValue };
    if (c && c[3] === 1 && !c[0] && !c[1] && !c[2]) return { via: 'framework', class: prop === 'background-color' ? 'bg-black' : prop === 'color' ? 'text-black' : 'border-black', expect: cssValue, note: 'black' };
    return { via: 'arbitrary', class: arbClass(prop, cssValue), expect: cssValue, note: 'no project token has this colour; check the framework palette by eye before flagging it as a gap' };
  }
  return { via: 'arbitrary', class: arbClass(prop, cssValue), expect: cssValue };
}

const simpleClass = (prop, v) => ({ 'flex-direction': { row: 'flex-row', column: 'flex-col' }, 'justify-content': { center: 'justify-center', 'flex-end': 'justify-end', 'space-between': 'justify-between', 'flex-start': 'justify-start' }, 'align-items': { center: 'items-center', 'flex-end': 'items-end', baseline: 'items-baseline', 'flex-start': 'items-start' }, 'text-align': { center: 'text-center', right: 'text-right', justify: 'text-justify', left: 'text-left' }, 'text-transform': { uppercase: 'uppercase', lowercase: 'lowercase', capitalize: 'capitalize' }, 'font-style': { italic: 'italic' }, 'text-decoration-line': { underline: 'underline', 'line-through': 'line-through' } })[prop]?.[v] || null;
const EQ_PROPS = new Set(['font-weight', 'text-align', 'flex-direction', 'display', 'justify-content', 'align-items', 'text-transform', 'font-style', 'text-decoration-line']);

function boundHint(node, keys, variables, styleKeys = []) {
  for (const k of keys) { const id = node.bound?.[k]; if (id && variables?.[id]) return variables[id].web ? variables[id].web.replace(/^var\(--|\)$/g, '') : variables[id].name; }
  for (const k of styleKeys) if (node.styles?.[k]) return node.styles[k];
  return null;
}

function nodeFacts(node, ctx, variables) {
  const f = [];
  const add = (prop, css, extra = {}) => {
    const c = { ...ctx, hint: extra.hint, fontSize: node.text?.size ?? ctx.fontSize };
    const m = mapValue(prop, css, c);
    const keep = EQ_PROPS.has(prop) && prop !== 'font-weight' ? { via: 'framework', class: simpleClass(prop, css), expect: css } : m;
    f.push({ prop, figma: css, op: EQ_PROPS.has(prop) ? '=' : '~', ...keep, ...(extra.hint ? { hint: extra.hint } : {}) });
  };
  const px = (v) => num(v) + 'px';
  const L = node.layout;
  if (node.text) {
    const t = node.text;
    add('font-size', px(t.size), { hint: boundHint(node, ['fontSize'], variables, ['text']) });
    add('font-weight', String(t.weight), { hint: null });
    if (t.lineHeight != null) {
      add('line-height', px(t.lineHeight), { hint: boundHint(node, ['lineHeight'], variables) });
      // a text-size token usually carries its line-height (--text-title--line-height): then `text-title` already sets it
      const fs = f.find((x) => x.prop === 'font-size'), lh = f[f.length - 1];
      const tok = fs.via === 'token' && ctx.tokens ? ctx.tokens.fontSize.find((x) => x.name === fs.ref) : null;
      if (tok?.lh != null && Math.abs(tok.lh * t.size - t.lineHeight) <= 1) Object.assign(lh, { via: 'token', ref: `${tok.name}--line-height`, class: `(set by ${fs.class})`, expect: px(t.lineHeight) });
    }
    if (node.color) add('color', node.color, { hint: boundHint(node, ['color'], variables, ['fill']) });
    if (t.align) add('text-align', t.align);
    if (t.transform && t.transform !== 'small-caps') add('text-transform', t.transform);
    if (t.letterSpacing) add('letter-spacing', px(t.letterSpacing));
    if (t.italic) add('font-style', 'italic');
    if (t.decoration) add('text-decoration-line', t.decoration);
  }
  if (L?.display === 'flex') {
    if (node.children?.length > 1 || L.gap != null) add('flex-direction', L.direction);
    if (L.gap != null) {
      if (L.wrap && L.crossGap != null && L.crossGap !== L.gap) { add(L.direction === 'row' ? 'column-gap' : 'row-gap', px(L.gap), { hint: boundHint(node, ['itemSpacing'], variables) }); add(L.direction === 'row' ? 'row-gap' : 'column-gap', px(L.crossGap), {}); }
      else add('gap', px(L.gap), { hint: boundHint(node, ['itemSpacing'], variables) });
    }
    if (L.justify && L.justify !== 'flex-start') add('justify-content', L.justify);
    if (L.align && L.align !== 'flex-start' && L.align !== 'baseline') add('align-items', L.align);
  } else if (L?.display === 'grid') {
    if (L.columnGap != null && L.columnGap === L.rowGap) add('gap', px(L.columnGap)); else { if (L.columnGap) add('column-gap', px(L.columnGap)); if (L.rowGap) add('row-gap', px(L.rowGap)); }
  }
  if (L?.padding) {
    const { t, r, b, l } = L.padding; const hint = boundHint(node, ['paddingLeft', 'paddingTop'], variables);
    if (t === r && r === b && b === l) add('padding', px(t), { hint });
    else for (const [p, v] of [['padding-top', t], ['padding-right', r], ['padding-bottom', b], ['padding-left', l]]) add(p, px(v), { hint });
  }
  if (node.fill) add('background-color', node.fill, { hint: boundHint(node, ['fill'], variables, ['fill']) });
  if (typeof node.radius === 'number') add('border-radius', px(node.radius), { hint: boundHint(node, ['cornerRadius', 'topLeftRadius'], variables) });
  if (node.stroke) {
    if (node.stroke.weight) add('border-width', px(node.stroke.weight));
    if (node.stroke.color?.startsWith('#')) add('border-color', node.stroke.color, { hint: boundHint(node, ['stroke'], variables, ['stroke']) });
  }
  if (node.shadow?.length) {
    const css = node.shadow.map((s) => `${s.type === 'inner' ? 'inset ' : ''}${num(s.x)}px ${num(s.y)}px ${num(s.blur)}px ${num(s.spread)}px ${s.color}`).join(', ');
    f.push({ prop: 'box-shadow', figma: css, op: '~', ...mapValue('box-shadow', css, { ...ctx, hint: null }), note: 'box-shadow is compared as text by expect:: use it only when the project has the matching shadow token, else check by eye' });
  }
  if ((node.role === 'icon' || node.role === 'image') && node.size && typeof node.size.w === 'number') { add('width', px(node.size.w)); if (typeof node.size.h === 'number') add('height', px(node.size.h)); }
  return f;
}

const hasInstanceBelow = (n) => (n.children || []).some((c) => (c.role === 'instance' && c.component) || hasInstanceBelow(c));
/** A leaf component instance (Button, Badge, Input...): no other component instance inside it (icons do not count). */
const isLeafInstance = (n) => !hasInstanceBelow(n);

/** Walk the normalised tree and produce { viewport, entries: [{ id, testid, name, path, role, text, component, facts: [...] }] }. */
export function buildFacts(norm, opts = {}) {
  const tokens = opts.designSystem ? indexTokens(opts.designSystem) : null;
  const tw = Number(opts.tailwind || tokens?.tailwind || 4);
  const variables = norm.variables || null;
  const used = new Map();
  const entries = [];
  const walk = (n, trail, inInst) => {
    const name = n.name || n.id;
    const internal = inInst || (!!n.component && n.role !== 'icon' && isLeafInstance(n)); // a Button/Badge-like component's own look is the project component's job; a Card-like instance holds page content, so its layers keep their facts
    const path = [...trail, name];
    const facts = nodeFacts(n, { tokens, tw }, variables);
    if (facts.length || n.component || n.role === 'icon' || n.role === 'image') {
      let id = slugName(name) || 'node'; const k = used.get(id) || 0; used.set(id, k + 1); if (k) id += '-' + (k + 1);
      const e = { id: n.id, testid: id, name, path: path.join(' > '), role: n.role };
      if (n.text?.chars) e.text = n.text.chars;
      if (n.component) e.component = n.component;
      if (internal) e.internal = true; // facts inside a component instance: map the component + props, add facts only for overrides
      if (n.styles) e.styles = n.styles;
      e.facts = facts.map((x) => (opts.at ? { ...x, at: opts.at } : x));
      entries.push(e);
    }
    if (n.role === 'icon') return; // an icon is exported as one asset: its vector layers are not facts
    for (const c of n.children || []) walk(c, path, internal);
  };
  const roots = norm.root ? [norm.root] : norm.roots || [];
  for (const r of roots) walk(r, []);
  return { source: norm.source, viewport: roots[0]?.box?.w ?? null, tailwind: tw, tokens: !!tokens, entries };
}

/** `expect:` line for a fact: `<selector> <prop> <op> <value> [@at]`. */
export function expectLine(selector, f) {
  return `${selector} ${f.prop} ${f.op} ${f.expect}${f.at ? ` @${f.at}` : ''}`;
}

// ---------------------------------------------------------------------------------------------- diff
function compareValues(prop, figma, code) {
  if (code == null || code === '') return { status: 'unknown' };
  const fc = parseColor(figma), cc = parseColor(code);
  if (fc && cc) { const d = colorDist(fc, cc); return { status: d <= 1 ? 'same' : d <= 6 ? 'close' : 'changed' }; }
  if (prop === 'font-weight') { const w = (x) => ({ normal: 400, bold: 700 }[String(x).toLowerCase()] ?? +x); return { status: w(figma) === w(code) ? 'same' : 'changed' }; }
  const fp = lengthPx(figma), cp = lengthPx(code);
  if (fp != null && cp != null) { const d = Math.abs(fp - cp); return { status: d <= 0.5 ? 'same' : d <= Math.max(1, Math.abs(fp) * 0.08) ? 'close' : 'changed' }; }
  const n = (x) => String(x).trim().toLowerCase().replace(/\s+/g, ' ');
  return { status: n(figma) === n(code) ? 'same' : 'changed' };
}

/**
 * Compare Figma facts with the current code's values: codeValues = { "<testid or node id>": { "<css prop>": "<value>" } }.
 * changed = real difference (becomes a task); close = within the visual check's tolerance (reported, not a task);
 * unknown = the code value was not supplied (go and read it, do not guess).
 */
export function diffFacts(facts, codeValues) {
  const rows = []; let internal = 0;
  for (const e of facts.entries) {
    const code = codeValues[e.testid] || codeValues[e.id];
    for (const f of e.facts) {
      if (f.prop === 'box-shadow') continue;
      if (e.internal && !code) { internal++; continue; } // inside a component instance: the component's own look, compared only if you supply its values
      const c = code ? code[f.prop] : undefined;
      const r = compareValues(f.prop, f.figma, c);
      rows.push({ node: e.name, id: e.id, testid: e.testid, prop: f.prop, figma: f.figma, code: c ?? null, status: code ? r.status : 'unknown', via: f.via, ref: f.ref ?? null, class: f.class ?? null, expect: f.expect });
    }
  }
  const count = (s) => rows.filter((r) => r.status === s).length;
  return { summary: { same: count('same'), close: count('close'), changed: count('changed'), unknown: count('unknown'), internal }, rows };
}
export function diffMarkdown(d) {
  const L = ['| Node | Selector | Property | Figma | Code now | Status | Change to |', '|---|---|---|---|---|---|---|'];
  for (const r of d.rows) L.push(`| ${r.node} | \`${r.testid}\` | ${r.prop} | ${r.figma} | ${r.code ?? '?'} | ${r.status} | ${r.status === 'changed' ? (r.via === 'token' ? `token ${r.ref} (${r.class})` : r.class || r.expect) : ''} |`);
  L.push('', `same ${d.summary.same}, close ${d.summary.close}, changed ${d.summary.changed}, unknown ${d.summary.unknown}${d.summary.internal ? `, ${d.summary.internal} facts inside component instances skipped (the component owns its look)` : ''}. Only "changed" rows become tasks; "unknown" rows need the current value read from the code.`);
  return L.join('\n');
}

// ---------------------------------------------------------------------------------------------- REST fetch
const TOKEN_HELP = 'FIGMA_TOKEN is not set. Create a personal access token (Figma > Settings > Security > Personal access tokens; scope file_content:read, plus file_variables:read on an Enterprise plan), export it in the shell that starts your agent (export FIGMA_TOKEN=...) and restart the agent. Never paste it into a file or into the chat. Without a token: connect the Figma MCP server, or give me an exported PNG/SVG of the frame (values will then be estimates).';

function bodyMessage(body) {
  if (!body) return '';
  if (typeof body === 'string') return body.slice(0, 200);
  const m = body.err || body.message || body.error || (body.meta && body.meta.message);
  return typeof m === 'string' ? m.slice(0, 200) : '';
}

/** GET from the Figma REST API. The token only ever leaves in the X-Figma-Token header; errors are plain sentences. */
export async function apiGet(route, { token, base = process.env.FIGMA_API_BASE || 'https://api.figma.com', fetchImpl = globalThis.fetch, fileKey } = {}) {
  if (!token) throw new FigmaError(TOKEN_HELP, EXIT.NO_TOKEN);
  let res;
  try { res = await fetchImpl(base.replace(/\/$/, '') + route, { headers: { 'X-Figma-Token': token, Accept: 'application/json' } }); }
  catch (e) { throw new FigmaError(redact(`could not reach ${new URL(base).host}: ${e.cause?.code || e.message}. Check the network/proxy; nothing was fetched.`), EXIT.HTTP); }
  let body = null;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  const detail = redact(bodyMessage(body));
  if (res.ok) return { status: res.status, body, headers: res.headers };
  if (res.status === 403) throw new FigmaError(`Figma answered 403 (forbidden)${detail ? `: ${detail}` : ''}. The token is invalid or expired, lacks the needed scope (file_content:read; file_variables:read for variables), or its account cannot open this file${fileKey ? ` (${fileKey})` : ''}. Create a new token or ask the owner to share the file with you.`, EXIT.HTTP);
  if (res.status === 404) throw new FigmaError(`Figma answered 404 (not found)${detail ? `: ${detail}` : ''}. Check the file key${fileKey ? ` "${fileKey}"` : ''} in the link (a branch link uses the branch key) and that the token's account can see the file.`, EXIT.HTTP);
  if (res.status === 429) {
    const h = (k) => res.headers.get(k);
    const bits = [h('retry-after') && `retry after ${h('retry-after')}s`, h('x-figma-plan-tier') && `plan tier ${h('x-figma-plan-tier')}`, h('x-figma-rate-limit-type') && `limit type ${h('x-figma-rate-limit-type')}`, h('x-figma-upgrade-link') && `upgrade: ${h('x-figma-upgrade-link')}`].filter(Boolean);
    throw new FigmaError(`Figma rate limit reached (429${bits.length ? ': ' + bits.join(', ') : ''}). Not retrying automatically: View/Collab seats have a small monthly budget. Reuse the cached node (--out dir, no --refresh), wait, or use the MCP server / an exported image instead.`, EXIT.RATE);
  }
  if (res.status === 400) throw new FigmaError(`Figma rejected the request (400)${detail ? `: ${detail}` : ''}.`, EXIT.HTTP);
  throw new FigmaError(`Figma answered ${res.status}${detail ? `: ${detail}` : ''}.`, EXIT.HTTP);
}

const safeName = (s) => (String(s || 'asset').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'asset').slice(0, 60);

async function download(url, file, fetchImpl) {
  const res = await fetchImpl(url); // pre-signed export URL: no token is sent here
  if (!res.ok) throw new FigmaError(`could not download an export (${res.status})`, EXIT.HTTP);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/** Fetch one node (+ variables, + optional exports), normalise, write to outDir. Returns the summary. */
export async function fetchNode(url, o = {}) {
  const env = o.env || process.env;
  const p = typeof url === 'string' ? parseFigmaUrl(url) : url;
  const nodeId = o.node ? normaliseNodeId(o.node) : p.nodeId;
  if (!nodeId) throw new FigmaError('the link has no node-id: fetching a whole Figma file is slow and uses a lot of the rate limit. Ask for a link to the frame or section (right-click it > Copy link to selection).', EXIT.USAGE);
  const token = env.FIGMA_TOKEN;
  if (!token) throw new FigmaError(TOKEN_HELP, EXIT.NO_TOKEN);
  const outDir = o.out || path.join(os.tmpdir(), 'figma-to-code', `${p.fileKey}-${nodeId.replace(/[:;]/g, '_')}`);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const nodeFile = path.join(outDir, 'node.json');
  const api = { token, base: o.base, fetchImpl: o.fetchImpl || globalThis.fetch, fileKey: p.fileKey };
  const summary = { fileKey: p.fileKey, nodeId, out: outDir, files: {}, warnings: [...p.warnings], cached: false };
  if (fs.existsSync(nodeFile) && !o.refresh) {
    const n = JSON.parse(fs.readFileSync(nodeFile, 'utf8'));
    return { ...summary, cached: true, files: { node: nodeFile }, stats: n.stats, warnings: [...summary.warnings, ...(n.warnings || []), 'reused the cached node.json (pass --refresh to fetch again)'] };
  }
  const q = new URLSearchParams({ ids: nodeId }); if (o.depth) q.set('depth', String(o.depth));
  const { body: raw } = await apiGet(`/v1/files/${p.fileKey}/nodes?${q}`, api);
  fs.writeFileSync(path.join(outDir, 'raw-nodes.json'), JSON.stringify(raw));
  let variables = null;
  if (!o.noVariables) {
    try { variables = (await apiGet(`/v1/files/${p.fileKey}/variables/local`, api)).body; fs.writeFileSync(path.join(outDir, 'variables.json'), JSON.stringify(variables)); summary.variables = 'loaded'; }
    catch (e) {
      if (e.code === EXIT.RATE || e.code === EXIT.NO_TOKEN) throw e;
      summary.variables = `unavailable: ${e.message.split('.')[0]}. Variable names are only readable by REST on Enterprise plans; the MCP get_variable_defs works on any Dev/Full seat. Falling back to styles and values.`;
    }
  }
  const norm = normalise(raw, { nodeId, fileKey: p.fileKey, variables, collapseInstances: o.collapseInstances, maxDepth: o.maxDepth, via: 'rest' });
  fs.writeFileSync(nodeFile, JSON.stringify(norm));
  summary.files.node = nodeFile; summary.stats = norm.stats; summary.warnings.push(...norm.warnings);
  const factsFile = path.join(outDir, 'facts.json');
  fs.writeFileSync(factsFile, compactJson(buildFacts(norm, { at: o.at })));
  summary.files.facts = factsFile;

  if (o.assets || o.screenshot) {
    const assetsDir = path.join(outDir, 'assets'); fs.mkdirSync(assetsDir, { recursive: true });
    const jobs = [];
    if (o.assets) {
      const walk = (n) => { if ((n.role === 'icon' || n.role === 'vector' || n.role === 'image') && !(n.role === 'image' && n.children?.length)) jobs.push({ id: n.id, name: n.name, fmt: n.role === 'image' ? 'png' : 'svg' }); if (n.role !== 'icon') (n.children || []).forEach(walk); };
      (norm.root ? [norm.root] : norm.roots || []).forEach(walk);
    }
    if (o.screenshot) jobs.push({ id: nodeId, name: 'screenshot', fmt: 'png', scale: 1 });
    const groups = {};
    for (const j of jobs) { const key = `${j.fmt}@${j.scale || o.scale || 2}`; (groups[key] ||= []).push(j); }
    const exported = [];
    for (const [key, list] of Object.entries(groups)) {
      const [fmt, scale] = key.split('@');
      for (let i = 0; i < list.length; i += 40) {
        const chunk = list.slice(i, i + 40);
        const qq = new URLSearchParams({ ids: chunk.map((c) => c.id).join(','), format: fmt }); if (fmt !== 'svg') qq.set('scale', scale);
        const { body } = await apiGet(`/v1/images/${p.fileKey}?${qq}`, api);
        for (const c of chunk) {
          const u = body?.images?.[c.id];
          if (!u) { summary.warnings.push(`export of "${c.name}" (${c.id}) returned no image (empty/hidden node, or Figma's renderer failed)`); continue; }
          const file = path.join(assetsDir, `${safeName(c.name)}-${c.id.replace(/[:;]/g, '_')}.${fmt}`);
          await download(u, file, api.fetchImpl); exported.push(path.relative(outDir, file));
        }
      }
    }
    summary.files.assets = exported;
  }
  return summary;
}

// ---------------------------------------------------------------------------------------------- CLI
function parseArgs(argv) {
  const o = { _: [] };
  const valued = new Set(['out', 'depth', 'scale', 'node', 'variables', 'max-depth', 'design-system', 'at', 'tailwind']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = (eq > 0 ? a.slice(2, eq) : a.slice(2));
      if (eq > 0) o[k] = a.slice(eq + 1);
      else if (valued.has(k)) { if (i + 1 >= argv.length) throw new FigmaError(`--${k} needs a value`, EXIT.USAGE); o[k] = argv[++i]; }
      else o[k] = true;
    } else o._.push(a);
  }
  return o;
}
const readJson = (f) => {
  try { return JSON.parse(f === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(f, 'utf8')); }
  catch (e) { throw new FigmaError(`cannot read JSON from ${f}: ${redact(e.message)}`, EXIT.USAGE); }
};
/** Compact JSON for the agent's context: one line per facts entry / diff row, one line for a tree. */
function compactJson(x) {
  for (const k of ['entries', 'rows']) if (x && Array.isArray(x[k])) { const { [k]: list, ...rest } = x; return JSON.stringify(rest).slice(0, -1) + `,"${k}":[\n` + list.map((e) => JSON.stringify(e)).join(',\n') + '\n]}'; }
  return JSON.stringify(x);
}
const USAGE = `usage: figma-fetch.mjs parse-url <url>
       figma-fetch.mjs fetch <url> [--node ID] [--out DIR] [--refresh] [--depth N] [--assets] [--screenshot] [--scale N] [--no-variables] [--collapse-instances] [--at WIDTH]
       figma-fetch.mjs normalise <raw.json|-> [--node ID] [--variables FILE] [--collapse-instances] [--max-depth N]
       figma-fetch.mjs facts <normalised.json> [--design-system FILE] [--at WIDTH] [--tailwind 3|4]
       figma-fetch.mjs diff <facts.json> <code-values.json> [--md] [--pretty]
fetch needs the FIGMA_TOKEN environment variable (never an argument).`;

export async function main(argv, io = { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') }) {
  const o = parseArgs(argv);
  const cmd = o._[0];
  const json = (x) => io.out(o.pretty ? JSON.stringify(x, null, 2) : compactJson(x));
  switch (cmd) {
    case 'parse-url': { if (!o._[1]) throw new FigmaError('parse-url needs a Figma URL', EXIT.USAGE); json(parseFigmaUrl(o._[1])); return EXIT.OK; }
    case 'fetch': {
      if (!o._[1]) throw new FigmaError('fetch needs a Figma URL', EXIT.USAGE);
      const s = await fetchNode(o._[1], { node: o.node, out: o.out, refresh: !!o.refresh, depth: o.depth && Number(o.depth), assets: !!o.assets, screenshot: !!o.screenshot, scale: o.scale && Number(o.scale), noVariables: !!o['no-variables'], collapseInstances: !!o['collapse-instances'], at: o.at });
      json(s); return EXIT.OK;
    }
    case 'normalise': case 'normalize': {
      if (!o._[1]) throw new FigmaError('normalise needs a raw response file (or - for stdin)', EXIT.USAGE);
      const vars = o.variables ? readJson(o.variables) : null;
      json(normalise(readJson(o._[1]), { nodeId: o.node ? normaliseNodeId(o.node) : undefined, variables: vars, collapseInstances: !!o['collapse-instances'], maxDepth: o['max-depth'] != null ? Number(o['max-depth']) : undefined, via: 'rest-file' })); return EXIT.OK;
    }
    case 'facts': {
      if (!o._[1]) throw new FigmaError('facts needs a normalised JSON file', EXIT.USAGE);
      json(buildFacts(readJson(o._[1]), { designSystem: o['design-system'] ? readJson(o['design-system']) : null, at: o.at, tailwind: o.tailwind })); return EXIT.OK;
    }
    case 'diff': {
      if (!o._[1] || !o._[2]) throw new FigmaError('diff needs <facts.json> <code-values.json>', EXIT.USAGE);
      const d = diffFacts(readJson(o._[1]), readJson(o._[2]));
      if (o.md) io.out(diffMarkdown(d)); else json(d);
      return EXIT.OK;
    }
    default: io.err(USAGE); return EXIT.USAGE;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => {
    process.stderr.write(redact(e instanceof FigmaError ? `figma-fetch: ${e.message}` : `figma-fetch: unexpected error: ${e.stack || e}`) + '\n');
    process.exitCode = e instanceof FigmaError ? e.code : EXIT.FAIL;
  });
}
