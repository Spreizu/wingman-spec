#!/usr/bin/env bash
# Doc-drift checks: the shipped text (harness, bundled first-party skills, built-in templates, docs) agrees with the CLI.
# - the AGENTS block stays short and points to `wingman-spec help reference`; every CLI command is in docs/reference.md;
# - every skill the apply instruction requires is named in the AGENTS block and the spec-implementer subagent;
# - the size tiers (caps, S/M limits, risk kinds) agree with internal/quality everywhere they are stated;
# - every exit code of the CLI is in the reference page;
# - no shipped text names the OpenSpec-era runtime (verify-task.cjs, openspec/ paths, openspec commands, stores) or a box path.
# Usage: tests/drift.sh   (needs node and the wingman-spec binary). Exit 0 when nothing drifted.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/ws.sh
. "$PKG/tests/lib/ws.sh"
HELP="$(mktemp)"; trap 'rm -f "$HELP"' EXIT
{ "$WS" --help; "$WS" help reference; for c in $("$WS" --help | awk '/^Available Commands:/{p=1;next} /^$/{p=0} p{print $1}'); do "$WS" "$c" --help; done; } > "$HELP" 2>&1
node - "$PKG" "$HELP" <<'JS'
const fs = require('fs'), path = require('path'), cp = require('child_process');
const pkg = process.argv[2], help = fs.readFileSync(process.argv[3], 'utf8'), read = (p) => fs.readFileSync(path.join(pkg, p), 'utf8');
const problems = [];
const ls = (...dirs) => cp.execFileSync('git', ['-C', pkg, 'ls-files', ...dirs], { encoding: 'utf8' }).split('\n').filter(Boolean)
  .filter((f) => fs.existsSync(path.join(pkg, f)) && !/\.(png|vsix|zip|ico|woff2?)$/.test(f));
const agents = read('harness/AGENTS.block.md'), reference = read('internal/cli/reference.md'), docRef = read('docs/reference.md');
// The AGENTS block is short on purpose: the full reference is `wingman-spec help reference`.
{ const w = agents.split(/\s+/).filter(Boolean).length, n = agents.split('\n').length;
  if (w > 1300 || n > 110) problems.push(`AGENTS block grew to ${n} lines / ${w} words (limit 110 / 1300): move detail into a command, a skill or the reference page`); }
if (!agents.includes('wingman-spec help reference')) problems.push('AGENTS block does not point to `wingman-spec help reference`');
// every CLI command is documented in docs/reference.md
const cmds = [...help.matchAll(/^Available Commands:\n([\s\S]*?)\n\n/gm)][0]?.[1].split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((c) => c && c !== 'help') || [];
for (const c of cmds) if (!docRef.includes('wingman-spec ' + c)) problems.push(`docs/reference.md does not document the command \`wingman-spec ${c}\``);
// every exit code is on the reference page
const codes = [...read('internal/cli/cli.go').matchAll(/^\tExit[A-Za-z]+\s*=\s*(\d+)$/gm)].map((m) => m[1]);
const exitLines = reference.slice(reference.indexOf('EXIT CODES'), reference.indexOf('WHAT check RUNS'));
for (const c of codes) if (!new RegExp(`(^|\\s)${c} `).test(exitLines)) problems.push(`the reference page does not explain exit code ${c}`);
// the skills the apply instruction requires
const schema = read('internal/artifacts/artifacts.yaml');
const apply = schema.slice(schema.indexOf('\napply:'));
const skills = [...new Set([...apply.matchAll(/`([a-z]+(?:-[a-z]+)*)` skill/g)].map((m) => m[1]))];
const implementer = read('harness/agents/spec-implementer.md');
for (const s of skills) {
  if (!agents.includes('`' + s + '`')) problems.push(`AGENTS block omits skill ${s}`);
  if (!implementer.includes('`' + s + '`')) problems.push(`spec-implementer omits skill ${s}`);
  if (!fs.existsSync(path.join(pkg, 'skills', s, 'SKILL.md'))) problems.push(`the apply instruction names a skill that is not bundled: ${s}`);
}
// Size tiers: internal/quality/plan.go is the one source; every place that states them agrees.
{ const plan = read('internal/quality/plan.go');
  const cap = (k) => (plan.match(new RegExp(`"${k}": (\\d+)`)) || [])[1];
  const num = (k) => (plan.match(new RegExp(`${k}\\s*=\\s*(\\d+)`)) || [])[1];
  const caps = `${cap('S')}/${cap('M')}/${cap('L')}`, capsSp = `${cap('S')} / ${cap('M')} / ${cap('L')}`;
  const risks = JSON.parse('[' + ((plan.match(/var Risks = \[\]string\{([^}]*)\}/) || [])[1] || '') + ']');
  if (!cap('S') || !num('SMaxRequirements') || !num('MMaxCapabilities') || risks.length < 3) problems.push('could not read the size rules from internal/quality/plan.go');
  const docs = { 'artifacts.yaml': schema, 'the reference page': reference, 'proposal template': read('internal/artifacts/templates/proposal.md'), 'spec-propose.md': read('harness/commands/spec-propose.md') };
  for (const [name, text] of Object.entries(docs)) {
    if (!text.includes(caps) && !text.includes(capsSp)) problems.push(`${name} does not state the task caps ${caps}`);
    if (!new RegExp(`(at most|<=) ${num('SMaxRequirements')} requirements`).test(text)) problems.push(`${name} does not state the S limit of ${num('SMaxRequirements')} requirements`);
    if (!new RegExp(`(up to|<=) ${num('MMaxCapabilities')} capabilities`).test(text)) problems.push(`${name} does not state the M limit of ${num('MMaxCapabilities')} capabilities`);
    for (const r of risks) if (!text.includes(r)) problems.push(`${name} does not name the risk kind ${r}`);
  }
  if (/^Size:/m.test(read('internal/artifacts/templates/tasks.md'))) problems.push('tasks template still carries a Size line (the size lives in proposal.md)');
}
// figma-to-code (first-party skill): wired into the design-map partial, the AGENTS block and docs/reference.md; every helper command,
// flag and reference file the SKILL.md names exists; the MCP URL agrees everywhere.
{ const sk = read('skills/figma-to-code/SKILL.md'), helper = read('skills/figma-to-code/scripts/figma-fetch.mjs');
  if (!/^name: figma-to-code$/m.test(sk)) problems.push('skills/figma-to-code/SKILL.md: name is not figma-to-code');
  for (const c of new Set([...sk.matchAll(/figma-fetch\.mjs\s+(?:"\$[A-Z]+"\s+)?([a-z-]+)/g), ...sk.matchAll(/\$H\s+([a-z-]+)/g)].map((m) => m[1])))
    if (!['parse-url', 'fetch', 'normalise', 'facts', 'diff'].includes(c)) problems.push(`figma-to-code SKILL.md names a helper command that does not exist: ${c}`);
  for (const f of new Set([...sk.matchAll(/ (--[a-z-]+)/g)].map((m) => m[1]))) if (!helper.includes(f) && !help.includes(f)) problems.push(`figma-to-code SKILL.md uses an option nobody implements: ${f}`);
  for (const m of sk.matchAll(/`(references\/[a-z-]+\.md)`/g)) if (!fs.existsSync(path.join(pkg, 'skills/figma-to-code', m[1]))) problems.push(`figma-to-code SKILL.md names a missing file ${m[1]}`);
  for (const [name, text] of Object.entries({ 'design-map partial': read('harness/partials/design-map.md'), 'AGENTS block': agents, 'docs/reference.md': docRef }))
    if (!text.includes('figma-to-code')) problems.push(`${name} does not mention the figma-to-code skill`);
  for (const [name, text] of Object.entries({ 'docs/reference.md': docRef, 'figma-sources.md': read('skills/figma-to-code/references/figma-sources.md') }))
    if (!text.includes('https://mcp.figma.com/mcp')) problems.push(`${name} lacks the Figma MCP URL`);
  for (const t of ['claude mcp add', 'codex mcp add figma', 'mcp.json']) if (!docRef.includes(t)) problems.push(`docs/reference.md lacks the Figma MCP setup for ${t}`);
  if (/figma-to-code/.test(read('skills/VENDORED.md'))) problems.push('figma-to-code is first party: it must not be listed in skills/VENDORED.md');
}
// spec-writing (first-party skill): loaded by the proposal instructions and /spec-propose; not vendored; passes the prose lint.
{ const sk = read('skills/spec-writing/SKILL.md');
  if (!/^name: spec-writing$/m.test(sk)) problems.push('skills/spec-writing/SKILL.md: name is not spec-writing');
  for (const f of ['internal/artifacts/artifacts.yaml', 'harness/commands/spec-propose.md']) if (!read(f).includes('`spec-writing` skill')) problems.push(`${f} does not load the spec-writing skill`);
  if (/spec-writing/.test(read('skills/VENDORED.md') + read('skills/vendor.lock'))) problems.push('spec-writing is first party: it must not be listed in skills/VENDORED.md or vendor.lock');
  const PL = require(path.join(pkg, 'scripts/prose-lint.cjs')); const w = PL.lintFile('skills/spec-writing/SKILL.md', sk).findings;
  if (w.length) problems.push(`skills/spec-writing/SKILL.md breaks its own rules: ${w.map((x) => x.rule).join(', ')}`);
  // The shipped prose: warnings are advisory (node scripts/prose-lint.cjs lists them); a sentence above 60 words is drift.
  for (const f of PL.defaultFiles()) for (const x of PL.lintFile(f, read(f)).findings) if (x.rule === 'sentence-hard') problems.push(`${f}:${x.line}: ${x.message}`);
}
// Docs describe the product, not its development branches: no branch codenames in the markdown outside skills/.
{ const code = new RegExp('\\b(' + ['next[0-9]', 'quality' + '-batch', 'size' + '-tiers', 'subagent' + '-apply', 'visual' + '-loop branch'].join('|') + ')\\b', 'i');
  for (const f of ls('*.md')) {
    if (f.startsWith('skills/')) continue;
    read(f).split('\n').forEach((l, i) => { if (code.test(l)) problems.push(`${f}:${i + 1} names a development branch; docs describe the product`); });
  }
}
// The shipped text: what the installed project, the user and the extension read.
const shipped = ls('harness', 'internal/artifacts', 'internal/scaffold', 'internal/cli/reference.md', 'skills/figma-to-code', 'skills/spec-writing', 'install.sh', 'README.md', 'docs',
  'vscode-extension/src', 'vscode-extension/README.md', 'vscode-extension/package.json').filter((f) => !/_test\.go$/.test(f));
let scanned = 0;
const each = (fn) => { for (const f of shipped) read(f).split('\n').forEach((l, i) => { scanned++; fn(f, i + 1, l); }); };
// The intents layer is gone: no shipped text names intent files, IN- ids, Derives lines, Intents sections or journey scenarios.
const intents = /\bIN-[a-z0-9]|\bDerives:|^#+ Intents\b/, intentsI = /\bjourney scenario|\bintents? (page|file|layer)\b|\bRetired intent/i;
// /spec-archive syncs by itself: no shipped text tells the user to run /spec-sync as a mandatory step before /spec-archive.
const syncFirst = [/\/spec-sync[^\n]*\bmandatory\b/i, /\bmandatory\b[^\n]*\/spec-sync/i, /sync is (mandatory|required)/i, /\/spec-sync[^\n]{0,90}\bthen\b[^\n]{0,15}\/spec-archive/i, /\/spec-sync[^\n]{0,60}\bbefore (every |each |the )?(archive|\/spec-archive)/i, /sync (specs )?first[^\n]*\/spec-archive|run \/spec-sync[^\n]*first/i];
// The OpenSpec-era runtime is gone. A line about the one-off converter (`wingman-spec import openspec`) may name it.
const v1 = /verify-task\.cjs|\bopenspec\/(scripts|specs|changes|config|workspace|\.apply-runs)|\bopenspec (archive|validate|new|list|instructions|status|store|context)\b|\.openspec\.yaml|store register|project-template|openspec-root|\bschemas\/wingman-spec/i;
const box = /\/Users\/|\/workspace\/|\/home\/box/;
each((f, n, l) => {
  if (intents.test(l) || intentsI.test(l)) problems.push(`${f}:${n} names the removed intents layer: a requirement carries its own Why line`);
  if (syncFirst.some((re) => re.test(l))) problems.push(`${f}:${n} tells the user to run /spec-sync before /spec-archive: /spec-archive syncs by itself`);
  if (v1.test(l) && !/import openspec|from OpenSpec|OpenSpec project|was:/i.test(l)) problems.push(`${f}:${n} names the OpenSpec-era runtime: ${l.trim().slice(0, 90)}`);
  if (box.test(l)) problems.push(`${f}:${n} names a machine path`);
});
if (scanned < 2000) problems.push(`the shipped-text scan looks broken: ${scanned} lines`);
if (cmds.length < 20 || skills.length < 6) problems.push(`extraction looks broken: ${cmds.length} commands, ${skills.length} skills`);
for (const p of problems) console.log(`  drift: ${p}`);
console.log(`drift: ${cmds.length} commands, ${skills.length} skills, ${scanned} shipped lines checked, ${problems.length} problems`);
process.exit(problems.length ? 1 : 0);
JS
