#!/usr/bin/env bash
# Doc-drift checks (B15): every verify-task.cjs option is documented in its `help` reference (the header comment; the
# AGENTS block only points to it and stays short), and every skill the
# schema's apply instruction requires is named in the config apply guidance, the AGENTS block and the
# spec-implementer subagent. Usage: tests/drift.sh   (needs node). Exit 0 when nothing drifted.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
node - "$PKG" <<'JS'
const fs = require('fs'), path = require('path');
const pkg = process.argv[2], read = (p) => fs.readFileSync(path.join(pkg, p), 'utf8');
const problems = [];
const opts = [...read('project-template/openspec/scripts/verify-task.cjs').matchAll(/case '(--[a-z-]+)'/g)].map((m) => m[1]);
const agents = read('project-template/AGENTS.block.md');
// The AGENTS block is short on purpose: the full reference is `verify-task.cjs help`, which prints the script's header comment.
const vtSrc = read('project-template/openspec/scripts/verify-task.cjs');
const help = (vtSrc.match(/\/\*([\s\S]*?)\*\//) || [])[1] || '';
{ const w = agents.split(/\s+/).filter(Boolean).length, n = agents.split('\n').length;
  if (w > 1300 || n > 110) problems.push(`AGENTS block grew to ${n} lines / ${w} words (limit 110 / 1300): move detail into a command, a skill or the verify-task help`); }
if (!agents.includes('verify-task.cjs help')) problems.push('AGENTS block does not point to `verify-task.cjs help`');
for (const o of opts) if (!help.includes(o)) problems.push(`verify-task help (header comment) does not document option ${o}`);
const schema = read('schemas/wingman-spec/schema.yaml');
const apply = schema.slice(schema.indexOf('\napply:'));
const skills = [...new Set([...apply.matchAll(/`([a-z]+(?:-[a-z]+)*)` skill/g)].map((m) => m[1]))];
const cfg = read('project-template/config.yaml.tmpl');
const guidance = cfg.slice(cfg.indexOf('operations:'), cfg.indexOf('  archive:'));
const implementer = read('project-template/harness/agents/spec-implementer.md');
for (const s of skills) {
  if (!guidance.includes('`' + s + '`')) problems.push(`config.yaml.tmpl operations.apply.guidance omits skill ${s}`);
  if (!agents.includes('`' + s + '`')) problems.push(`AGENTS block omits skill ${s}`);
  if (!implementer.includes('`' + s + '`')) problems.push(`spec-implementer omits skill ${s}`);
}
// config.yaml rules must be arrays of plain strings, or openspec drops the artifact's rules with only a warning.
{ const rulesBlock = cfg.slice(cfg.indexOf('\nrules:'), cfg.indexOf('\noperations:'));
  for (const [i, line] of rulesBlock.split('\n').entries()) {
    const m = line.match(/^\s+- (.*)$/); if (!m) continue; const v = m[1];
    if (/^'/.test(v) && /'/.test(v.slice(1, -1).replace(/''/g, ''))) problems.push(`config.yaml.tmpl rules line ${i}: an apostrophe inside a single-quoted string must be doubled ('') or openspec ignores the whole config: ${v.slice(0, 60)}`);
    if (/^["']/.test(v) ? !/^(["']).*\1$/.test(v) : /: /.test(v)) problems.push(`config.yaml.tmpl rules line ${i}: not a plain YAML string: ${v.slice(0, 60)}`);
  } }
// Size tiers: one source of truth (quality.cjs) for the caps and the S/M thresholds; every place that states them agrees.
{ const Q = require(path.join(pkg, 'project-template/openspec/scripts/quality.cjs'));
  const caps = `${Q.CAPS.S}/${Q.CAPS.M}/${Q.CAPS.L}`, capsSp = `${Q.CAPS.S} / ${Q.CAPS.M} / ${Q.CAPS.L}`;
  const R = Q.SIZE_RULES;
  const docs = { 'schema.yaml': schema, 'config.yaml.tmpl': cfg, 'verify-task help': help,
    'proposal template': read('schemas/wingman-spec/templates/proposal.md'), 'spec-propose.md': read('project-template/harness/commands/spec-propose.md') };
  for (const [name, text] of Object.entries(docs)) {
    if (!text.includes(caps) && !text.includes(capsSp)) problems.push(`${name} does not state the task caps ${caps}`);
    if (!new RegExp(`(at most|<=) ${R.S_MAX_REQUIREMENTS} requirements`).test(text)) problems.push(`${name} does not state the S limit of ${R.S_MAX_REQUIREMENTS} requirements`);
    if (!new RegExp(`(up to|<=) ${R.M_MAX_CAPABILITIES} capabilities`).test(text)) problems.push(`${name} does not state the M limit of ${R.M_MAX_CAPABILITIES} capabilities`);
    for (const r of Q.RISKS) if (!text.includes(r)) problems.push(`${name} does not name the risk kind ${r}`);
  }
  if (/^Size:/m.test(read('schemas/wingman-spec/templates/tasks.md'))) problems.push('tasks template still carries a Size line (the size lives in proposal.md)');
  // every verify-task subcommand is in the documented usage line
  const vt = read('project-template/openspec/scripts/verify-task.cjs');
  const cmds = (vt.match(/\[('next'[^\]]*)\]\.includes\(o\.cmd/) || [])[1];
  for (const c of (cmds || '').split(',').map((x) => x.trim().replace(/'/g, ''))) if (c && !help.includes(`verify-task.cjs ${c} `)) problems.push(`verify-task help does not document the command ${c}`);
  if (!cmds) problems.push('could not read the verify-task command list');
  // every config.yaml rules key is a schema artifact id (openspec ignores unknown ones)
  const ids = [...schema.matchAll(/^  - id: ([a-z-]+)/gm)].map((m) => m[1]);
  const rulesBlock = cfg.slice(cfg.indexOf('\nrules:'), cfg.indexOf('\noperations:'));
  for (const m of rulesBlock.matchAll(/^  ([a-z-]+):$/gm)) if (!ids.includes(m[1])) problems.push(`config.yaml.tmpl rules key ${m[1]} is not a schema artifact`);
}
// figma-to-code (first-party skill): wired into the design-map partial, the AGENTS block, docs/reference.md and install.sh;
// every helper command/flag and reference file the SKILL.md names exists; the MCP URL agrees everywhere.
{ const sk = read('skills/figma-to-code/SKILL.md'), helper = read('skills/figma-to-code/scripts/figma-fetch.mjs');
  if (!/^name: figma-to-code$/m.test(sk)) problems.push('skills/figma-to-code/SKILL.md: name is not figma-to-code');
  const usage = helper.slice(helper.indexOf('const USAGE') >= 0 ? helper.indexOf('const USAGE') : helper.indexOf('usage:'));
  for (const c of new Set([...sk.matchAll(/figma-fetch\.mjs\s+(?:"\$[A-Z]+"\s+)?([a-z-]+)/g), ...sk.matchAll(/\$H\s+([a-z-]+)/g)].map((m) => m[1])))
    if (!['parse-url', 'fetch', 'normalise', 'facts', 'diff'].includes(c)) problems.push(`figma-to-code SKILL.md names a helper command that does not exist: ${c}`);
  for (const f of new Set([...sk.matchAll(/ (--[a-z-]+)/g)].map((m) => m[1]))) if (!helper.includes(f) && !read('project-template/openspec/scripts/verify-task.cjs').includes(f)) problems.push(`figma-to-code SKILL.md uses an option nobody implements: ${f}`);
  for (const m of sk.matchAll(/`(references\/[a-z-]+\.md)`/g)) if (!fs.existsSync(path.join(pkg, 'skills/figma-to-code', m[1]))) problems.push(`figma-to-code SKILL.md names a missing file ${m[1]}`);
  for (const [name, text] of Object.entries({ 'design-map partial': read('project-template/harness/partials/design-map.md'), 'AGENTS block': agents, 'docs/reference.md': read('docs/reference.md'), 'install.sh': read('install.sh') }))
    if (!text.includes('figma-to-code')) problems.push(`${name} does not mention the figma-to-code skill`);
  for (const [name, text] of Object.entries({ 'docs/reference.md': read('docs/reference.md'), 'figma-sources.md': read('skills/figma-to-code/references/figma-sources.md') }))
    if (!text.includes('https://mcp.figma.com/mcp')) problems.push(`${name} lacks the Figma MCP URL`);
  for (const t of ['claude mcp add', 'codex mcp add figma', 'mcp.json']) if (!read('docs/reference.md').includes(t)) problems.push(`docs/reference.md lacks the Figma MCP setup for ${t}`);
  if (/figma-to-code/.test(read('skills/VENDORED.md'))) problems.push('figma-to-code is first party: it must not be listed in skills/VENDORED.md');
}
// spec-writing (first-party skill): loaded by the schema and /spec-propose; not vendored; passes the prose lint.
{ const sk = read('skills/spec-writing/SKILL.md');
  if (!/^name: spec-writing$/m.test(sk)) problems.push('skills/spec-writing/SKILL.md: name is not spec-writing');
  for (const f of ['schemas/wingman-spec/schema.yaml', 'project-template/harness/commands/spec-propose.md']) if (!read(f).includes('`spec-writing` skill')) problems.push(`${f} does not load the spec-writing skill`);
  if (/spec-writing/.test(read('skills/VENDORED.md') + read('skills/vendor.lock'))) problems.push('spec-writing is first party: it must not be listed in skills/VENDORED.md or vendor.lock');
  const PL = require(path.join(pkg, 'scripts/prose-lint.cjs')); const w = PL.lintFile('skills/spec-writing/SKILL.md', sk).findings;
  if (w.length) problems.push(`skills/spec-writing/SKILL.md breaks its own rules: ${w.map((x) => x.rule).join(', ')}`);
  // The shipped prose: warnings are advisory (node scripts/prose-lint.cjs lists them); a sentence above 60 words is drift.
  for (const f of PL.defaultFiles()) for (const x of PL.lintFile(f, read(f)).findings) if (x.rule === 'sentence-hard') problems.push(`${f}:${x.line}: ${x.message}`);
}
// Docs describe the product, not its development branches: no branch codenames in the markdown outside skills/.
{
  const code = new RegExp('\\b(' + ['next[0-9]', 'quality' + '-batch', 'size' + '-tiers', 'subagent' + '-apply', 'visual' + '-loop branch'].join('|') + ')\\b', 'i');
  let files = [];
  try { files = require('child_process').execFileSync('git', ['-C', pkg, 'ls-files', '*.md'], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch (e) { /* not a git checkout */ }
  for (const f of files) {
    if (f.startsWith('skills/')) continue;
    fs.readFileSync(path.join(pkg, f), 'utf8').split('\n').forEach((l, i) => { if (code.test(l)) problems.push(`${f}:${i + 1} names a development branch; docs describe the product`); });
  }
}
// The intents layer is gone: no shipped text names intent files, IN- ids, Derives lines, Intents sections or journey scenarios.
{
  const out = require('child_process').execFileSync('git', ['-C', pkg, 'ls-files', 'project-template', 'schemas', 'install.sh', 'README.md', 'docs', 'vscode-extension/src', 'vscode-extension/README.md', 'vscode-extension/package.json'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const old = /\bIN-[a-z0-9]|\bDerives:|^#+ Intents\b|openspec\/intents/; const oldI = /\bjourney scenario|\bintents? (page|file|layer)\b|\bRetired intent/i;
  for (const f of out) {
    if (!fs.existsSync(path.join(pkg, f)) || /\.(png|vsix|zip)$/.test(f)) continue;
    fs.readFileSync(path.join(pkg, f), 'utf8').split('\n').forEach((l, i) => { if (old.test(l) || oldI.test(l)) problems.push(`${f}:${i + 1} names the removed intents layer: a requirement carries its own Why line`); });
  }
}
// /spec-archive syncs first by itself: no shipped text (templates, commands, scripts, installer, schema, README, extension) tells the user
// to run /spec-sync as a mandatory step before /spec-archive.
{
  const out = require('child_process').execFileSync('git', ['-C', pkg, 'ls-files', 'project-template', 'schemas', 'install.sh', 'README.md', 'docs', 'vscode-extension/src', 'vscode-extension/README.md'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const bad = [/\/spec-sync[^\n]*\bmandatory\b/i, /\bmandatory\b[^\n]*\/spec-sync/i, /sync is (mandatory|required)/i, /\/spec-sync[^\n]{0,90}\bthen\b[^\n]{0,15}\/spec-archive/i, /\/spec-sync[^\n]{0,60}\bbefore (every |each |the )?(archive|\/spec-archive)/i, /sync (specs )?first[^\n]*\/spec-archive|run \/spec-sync[^\n]*first/i];
  let n = 0;
  for (const f of out) {
    if (!fs.existsSync(path.join(pkg, f)) || /\.(png|vsix|zip)$/.test(f)) continue;
    fs.readFileSync(path.join(pkg, f), 'utf8').split('\n').forEach((l, i) => { n++; if (bad.some((re) => re.test(l))) problems.push(`${f}:${i + 1} tells the user to run /spec-sync before /spec-archive: /spec-archive syncs first by itself`); });
  }
  if (n < 500) problems.push(`sync-wording scan looks broken: ${n} lines`);
}
// every export of the project scripts has a consumer (another script, a test or the extension); an unused export is dropped
try { require('child_process').execFileSync('node', [path.join(pkg, 'tests/lib/export-consumers.cjs'), pkg, '--check'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
catch (e) { for (const l of String(e.stdout || e.message).split('\n').filter(Boolean)) problems.push(l); }
if (opts.length < 8 || skills.length < 6) problems.push(`extraction looks broken: ${opts.length} options, ${skills.length} skills`);
for (const p of problems) console.log(`  drift: ${p}`);
console.log(`drift: ${opts.length} options, ${skills.length} skills checked, ${problems.length} problems`);
process.exit(problems.length ? 1 : 0);
JS
