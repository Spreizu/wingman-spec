#!/usr/bin/env node
/**
 * json-patch.cjs: change a JSON file the user may have edited, without reformatting it.
 * The file is rewritten only when its text is exactly what JSON.stringify would write for it (indent detected: tabs or N spaces,
 * final newline kept). Then the only difference is the added entry. A file with comments, another layout (compact, aligned,
 * unusual spacing) or invalid JSON is left untouched and the caller says what to add by hand.
 *
 * Library: patch(file, (json) => void) -> 'written' | 'created' | 'manual'      (create: no file yet, `{}` is the start)
 */
const fs = require('fs');

function indentOf(text) {
  const m = text.match(/^([ \t]+)\S/m);
  if (!m) return 2;
  return m[1][0] === '\t' ? '\t' : m[1].length;
}
function render(json, text) {
  const nl = /\r\n/.test(text) ? '\r\n' : '\n';
  const s = JSON.stringify(json, null, indentOf(text)).replace(/\n/g, nl);
  return s + (/\n$/.test(text) ? nl : '');
}
function patch(file, change) {
  if (!fs.existsSync(file)) {
    const j = {}; change(j); fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n'); return 'created';
  }
  const text = fs.readFileSync(file, 'utf8');
  let j; try { j = JSON.parse(text); } catch (e) { return 'manual'; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return 'manual';
  if (render(j, text) !== text) return 'manual';   // the layout is the user's own: do not reformat it
  change(j);
  fs.writeFileSync(file, render(j, text));
  return 'written';
}
module.exports = { patch };

if (require.main === module) { // CLI: json-patch.cjs FILE 'js statements using j'   (prints written | created | manual)
  const [file, js] = process.argv.slice(2);
  console.log(patch(file, (j) => { j.hooks = j.hooks || {}; new Function('j', js)(j); }));
}
