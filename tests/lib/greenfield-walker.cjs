#!/usr/bin/env node
'use strict';
/*
 * Scripted stand-in for the agent in greenfield tests and measurements. It reads ONLY `verify-task.cjs greenfield status --json`,
 * performs the action that status names with canned content from a fixture directory (tests/fixtures/greenfield/kitchenbox),
 * and counts wrong turns: an action the verifier refused, or a step that did not advance. It measures the state machine
 * (does following the entry command's output alone reach READY FOR HANDOVER, in order), not the quality of agent-written content.
 *
 *   greenfield-walker.cjs --project DIR --fixture DIR [--sloppy] [--stop-at STEP]   prints a JSON report
 */
const fs = require('fs'); const path = require('path'); const { spawnSync } = require('child_process');
const a = process.argv.slice(2); const arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
const project = path.resolve(arg('--project')); const fx = path.resolve(arg('--fixture')); const sloppy = a.includes('--sloppy'); const stopAt = arg('--stop-at');
const VT = path.join(project, 'openspec/scripts/verify-task.cjs');
const env = { ...process.env, OPENSPEC_TELEMETRY: '0' };
const run = (args, o = {}) => spawnSync(process.execPath, [VT, ...args], { cwd: project, encoding: 'utf8', env, input: o.input });
const rd = (f) => fs.readFileSync(f, 'utf8'); const wr = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const copyRecords = (prefix) => { const to = path.join(project, 'openspec/greenfield/records'); fs.mkdirSync(to, { recursive: true }); for (const f of fs.readdirSync(path.join(fx, 'greenfield/records'))) if (f.startsWith(prefix)) fs.copyFileSync(path.join(fx, 'greenfield/records', f), path.join(to, f)); };
const copy = (from, to) => fs.cpSync(path.join(fx, from), path.join(project, to), { recursive: true });
const status = () => { const r = run(['greenfield', 'status', '--json']); try { return JSON.parse(r.stdout); } catch (e) { return { step: 'unreadable', raw: r.stdout + r.stderr }; } };
const answers = JSON.parse(rd(path.join(fx, 'answers.json')));
const report = { steps: [], wrong_turns: 0, refused: [], recovered_mistakes: 0, ready: false, final_step: null, actions: 0 };
const wrong = (why) => { report.wrong_turns++; report.refused.push(why); };
const cli = (args, what) => { report.actions++; const r = run(args); if (r.status !== 0) wrong(`${what || args.join(' ')}: exit ${r.status}: ${(r.stdout + r.stderr).split('\n').filter(Boolean).slice(0, 2).join(' | ')}`); return r; };
const setQ = (topic, st, text) => { const f = path.join(project, `openspec/greenfield/records/Q-${topic}.md`); let t = rd(f).replace(/^status:.*$/m, `status: ${st}`); if (text !== null) t = t.replace(/## Answer[\s\S]*$/, `## Answer\n${text}\n`); wr(f, t); };
const mergeSpecs = (change) => {
  const dir = path.join(project, 'openspec/changes', change, 'specs');
  for (const cap of fs.readdirSync(dir)) wr(path.join(project, 'openspec/specs', cap, 'spec.md'), rd(path.join(dir, cap, 'spec.md')).replace(/^## ADDED Requirements/m, '## Requirements'));
  const adrs = path.join(project, 'openspec/changes', change, 'adrs'); if (fs.existsSync(adrs)) for (const f of fs.readdirSync(adrs)) {
    const ad = path.join(project, 'adr'); const n = fs.existsSync(ad) ? fs.readdirSync(ad).filter((x) => /^\d{4}-/.test(x)).length + 1 : 1; const slug = f.replace(/\.md$/, '');
    wr(path.join(ad, `${String(n).padStart(4, '0')}-${slug}.md`), rd(path.join(adrs, f)).replace(/^change: .*$/m, `change: ${change}\nsource: ${change}/${slug}`).replace(/^status: .*$/m, 'status: Accepted'));
  }
};
const syncChange = (change) => { mergeSpecs(change); const r = cli(['sync', change], `sync ${change}`); return r; };
let sloppyDone = new Set();
const handlers = {
  'confirm-start': () => cli(['greenfield', 'start', '--by', 'Anna Analyst', '--yes']),
  'add-inputs': () => copy('inputs', 'openspec/inputs'),
  'explore': () => { cli(['greenfield', 'new', 'exploration']); fs.copyFileSync(path.join(fx, 'greenfield/exploration.md'), path.join(project, 'openspec/greenfield/exploration.md')); copy('greenfield/capabilities', 'openspec/greenfield/capabilities'); },
  'finish-exploration': () => { fs.copyFileSync(path.join(fx, 'greenfield/exploration.md'), path.join(project, 'openspec/greenfield/exploration.md')); copy('greenfield/capabilities', 'openspec/greenfield/capabilities'); },
  'create-questions': () => cli(['greenfield', 'new', 'questions']),
  'answer-questions': () => { for (const [topic, [st, text]] of Object.entries(answers.answers)) { const q = rd(path.join(project, `openspec/greenfield/records/Q-${topic}.md`)); if (/^status: open/m.test(q)) setQ(topic, st, st === 'assumed' ? 'Assumed, see A-design-freeform.' : st === 'asked' ? null : text); } },
  'write-assumptions': () => copyRecords('A-'),
  'wait-for-client': () => { for (const [topic, text] of Object.entries(answers.late)) setQ(topic, 'answered', text); },
  'write-understood': () => { cli(['greenfield', 'new', 'understood']); fs.copyFileSync(path.join(fx, 'greenfield/understood.md'), path.join(project, 'openspec/greenfield/understood.md')); },
  'approve-understood': () => cli(['greenfield', 'approve', 'understood', '--by', 'Carl Client']),
  'propose-foundation': () => { copy('changes/foundation', 'openspec/changes/foundation'); fs.copyFileSync(path.join(fx, 'glossary.md'), path.join(project, 'openspec/glossary.md')); },
  'finish-foundation': () => { fs.copyFileSync(path.join(fx, 'glossary.md'), path.join(project, 'openspec/glossary.md')); },
  'sync-foundation': () => syncChange('foundation'),
  'archive-foundation': () => cli(['archive', 'foundation']),
  'describe-sandbox': () => copy('greenfield/capabilities', 'openspec/greenfield/capabilities'),
  'propose-capability': (st) => {
    const name = (st.next.problems[0].match(/: ([a-z0-9-]+)$/) || [])[1]; copy(`changes/${name}`, `openspec/changes/${name}`);
    if (sloppy && name === 'billing' && !sloppyDone.has(name)) { sloppyDone.add(name); const f = path.join(project, `openspec/changes/${name}/specs/${name}/spec.md`); wr(f, rd(f).replace(/#### Scenario: Failure:[^\n]*\n(?:(?!#{3,4} )[^\n]*\n?)*/g, '')); }
  },
  'finish-capability': (st) => { const name = (st.next.problems[0].match(/: ([a-z0-9-]+)$/) || [])[1]; report.recovered_mistakes++; copy(`changes/${name}`, `openspec/changes/${name}`); },
  'sync-capability': (st) => syncChange((st.next.problems[0].match(/: ([a-z0-9-]+)$/) || [])[1]),
  'archive-capability': (st) => cli(['archive', (st.next.problems[0].match(/: ([a-z0-9-]+)$/) || [])[1]]),
  'review-spec': () => { cli(['greenfield', 'review', 'spec', '--packet', '--out', 'openspec/.apply-runs/greenfield/spec-packet.md']); cli(['greenfield', 'review', 'spec', '--reply', path.join(fx, 'replies/spec.txt')]); },
  'signoff-spec': () => cli(['greenfield', 'approve', 'spec', '--by', 'Carl Client']),
  'plan': () => { copy('slices', 'openspec/roadmap'); if (sloppy) { const f = path.join(project, 'openspec/roadmap/skip-and-pause.md'); wr(f, rd(f).replace('size: L', 'size: M')); } },
  'fix-roadmap': (st) => { // follows the verifier's text: "<slice>: declares size M but needs L"
    report.recovered_mistakes++; let fixed = 0;
    for (const p of st.next.problems) { const m = p.match(/^([a-z0-9-]+): declares size ([SML]) but needs ([SML])/); if (m) { const f = path.join(project, `openspec/roadmap/${m[1]}.md`); wr(f, rd(f).replace(/^size: .*$/m, `size: ${m[3]}`)); fixed++; } }
    if (!fixed) wrong(`fix-roadmap: nothing the walker can fix from: ${st.next.problems.join(' | ').slice(0, 160)}`);
  },
  'review-plan': () => { cli(['greenfield', 'review', 'plan', '--packet', '--out', 'openspec/.apply-runs/greenfield/plan-packet.md']); cli(['greenfield', 'review', 'plan', '--reply', path.join(fx, 'replies/plan.txt')]); },
  'dry-run': () => { cli(['greenfield', 'review', 'dryrun', '--packet', '--out', 'openspec/.apply-runs/greenfield/dryrun-packet.md']); cli(['greenfield', 'review', 'dryrun', '--reply', path.join(fx, 'replies/dryrun.txt')]); },
  'write-environments': () => { copyRecords('ENV-'); },
  'fix-gate': () => { copyRecords('ENV-'); },
  'write-handover': () => cli(['handover', '--write']),
};
let last = ''; let same = 0;
for (let i = 0; i < 200; i++) {
  const st = status();
  if (st.ready || st.step === 'ready') { report.ready = true; report.final_step = 'ready'; break; }
  const key = `${st.step}|${JSON.stringify(st.next && st.next.problems)}`;
  if (key === last) { same++; if (same >= 2) { wrong(`stuck: step ${st.step} did not advance after its action`); report.final_step = st.step; break; } } else same = 0;
  last = key; report.steps.push(st.step);
  if (stopAt && st.step === stopAt) { report.final_step = st.step; break; }
  const h = handlers[st.step];
  if (!h) { wrong(`no action for step ${st.step}: ${(st.next && st.next.do || st.raw || '').slice(0, 120)}`); report.final_step = st.step; break; }
  h(st);
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
