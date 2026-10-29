// usage: node tests/lib/export-consumers.cjs [<repo>] [--json|--check]
// Lists each export of project-template/openspec/scripts/*.cjs and who consumes it (another script, a test, the extension).
// --check exits 1 when an export has no consumer at all: drop the export (and the function when nothing else uses it).
const fs = require('fs'), path = require('path');
const repo = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(__dirname, '../..'));
const scriptsDir = path.join(repo, 'project-template/openspec/scripts');
function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', '.git', 'out'].includes(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(cjs|mjs|js|ts|sh)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = walk(repo).filter((f) => !f.includes('/skills/') );
const text = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const rows = [];
for (const m of fs.readdirSync(scriptsDir).filter((x) => x.endsWith('.cjs') && x !== 'verify-task.cjs').sort()) {
  const mp = path.join(scriptsDir, m);
  let names; try { names = Object.keys(require(mp)); } catch (e) { console.error('cannot load', m, e.message); continue; }
  for (const name of names) {
    const esc = name.replace(/[$]/g, '\\$');
    const member = new RegExp('[.\\]]' + esc + '\\b');
    const destr = new RegExp('\\{[^{}]*\\b' + esc + '\\b[^{}]*\\}\\s*=\\s*(?:require\\(|[A-Za-z_.]+\\s*[;\\n,)])');
    const cons = { script: [], test: [], ext: [], other: [] };
    for (const [f, t] of text) {
      if (f === mp) continue;
      if (!t.includes(m)  && !(f.startsWith(scriptsDir))) continue; // consumer must name the module (tests/extension); sibling scripts require it by relative name
      if (f.startsWith(scriptsDir) && !t.includes(m)) continue;
      if (f.startsWith(scriptsDir)) {
        const reqRe = new RegExp("(?:const|let|var)\\s+(\\{[^}]*\\}|\\w+)\\s*=\\s*require\\(['\"]\\./" + m.replace('.', '\\.') + "['\"]\\)([.\\w]*)", 'g');
        let hit = false, b;
        while ((b = reqRe.exec(t))) {
          if (b[1][0] === '{') { if (new RegExp('\\b' + esc + '\\b').test(b[1])) hit = true; }
          else if (new RegExp('\\b' + b[1] + '\\.' + esc + '\\b').test(t) || new RegExp('\\{[^{}]*\\b' + esc + '\\b[^{}]*\\}\\s*=\\s*' + b[1] + '\\b').test(t)) hit = true;
          if (b[2] && b[2].slice(1) === name) hit = true;
        }
        if (new RegExp("require\\(['\"]\\./" + m.replace('.', '\\.') + "['\"]\\)\\." + esc + '\\b').test(t)) hit = true;
        if (!hit) continue;
      } else if (!(member.test(t) || destr.test(t))) continue;
      const rel = path.relative(repo, f);
      (rel.startsWith('project-template/openspec/scripts') ? cons.script : rel.startsWith('tests/') ? cons.test : rel.startsWith('vscode-extension/') ? cons.ext : cons.other).push(rel);
    }
    const own = (text.get(mp).match(new RegExp('\\b' + esc + '\\b', 'g')) || []).length;
    rows.push({ module: m, name, script: cons.script, test: cons.test, ext: cons.ext, other: cons.other, ownUses: own });
  }
}
if (process.argv.includes('--check')) {
  const none = rows.filter((r) => !r.script.length && !r.test.length && !r.ext.length && !r.other.length);
  for (const r of none) console.log(`${r.module}: export '${r.name}' has no consumer`);
  process.exit(none.length ? 1 : 0);
} else if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 1));
else {
  const none = rows.filter((r) => !r.script.length && !r.test.length && !r.ext.length && !r.other.length);
  const testOnly = rows.filter((r) => !r.script.length && !r.ext.length && !r.other.length && r.test.length);
  console.log(`exports: ${rows.length}; used by a script/extension: ${rows.filter((r) => r.script.length || r.ext.length || r.other.length).length}; test only: ${testOnly.length}; no consumer: ${none.length}`);
  console.log('-- no consumer');
  for (const r of none) console.log(`${r.module}\t${r.name}\town-file mentions=${r.ownUses}`);
  console.log('-- test only');
  for (const r of testOnly) console.log(`${r.module}\t${r.name}\t${r.test.join(',')}\town=${r.ownUses}`);
}
