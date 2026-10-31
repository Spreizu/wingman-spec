#!/usr/bin/env node
'use strict';
/*
 * Scripted stand-in for the agent in greenfield tests and measurements. It reads ONLY `wingman-spec greenfield status --json`,
 * performs the action that status names with canned content from a fixture directory (tests/fixtures/greenfield/kitchenbox),
 * and counts wrong turns: an action the CLI refused, or a step that did not advance. It measures the state machine
 * (does following the entry command's output alone reach READY FOR HANDOVER, in order), not the quality of agent-written content.
 *
 *   greenfield-walker.cjs --project DIR --fixture DIR [--sloppy] [--stop-at STEP]   prints a JSON report
 * The binary is $WS or $WINGMAN_SPEC_BIN (default: wingman-spec on PATH).
 */
const fs = require('fs'); const path = require('path'); const { spawnSync } = require('child_process');
const a = process.argv.slice(2); const arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
const project = path.resolve(arg('--project')); const fx = path.resolve(arg('--fixture')); const sloppy = a.includes('--sloppy'); const stopAt = arg('--stop-at');
const BIN = process.env.WS || process.env.WINGMAN_SPEC_BIN || 'wingman-spec';
const S = '.wingman-spec'; // the specs root next to the code
const run = (args, o = {}) => spawnSync(BIN, args, { cwd: project, encoding: 'utf8', input: o.input });
const rd = (f) => fs.readFileSync(f, 'utf8'); const wr = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const P = (...p) => path.join(project, S, ...p);
const copyRecords = (prefix) => { const to = P('greenfield/records'); fs.mkdirSync(to, { recursive: true }); for (const f of fs.readdirSync(path.join(fx, 'greenfield/records'))) if (f.startsWith(prefix)) fs.copyFileSync(path.join(fx, 'greenfield/records', f), path.join(to, f)); };
const copy = (from, to) => fs.cpSync(path.join(fx, from), P(to), { recursive: true });
const status = () => { const r = run(['greenfield', 'status', '--json']); try { return JSON.parse(r.stdout); } catch (e) { return { step: 'unreadable', raw: r.stdout + r.stderr }; } };
const answers = JSON.parse(rd(path.join(fx, 'answers.json')));
const report = { steps: [], wrong_turns: 0, refused: [], recovered_mistakes: 0, ready: false, final_step: null, actions: 0 };
const wrong = (why) => { report.wrong_turns++; report.refused.push(why); };
const cli = (args, what) => { report.actions++; const r = run(args); if (r.status !== 0) wrong(`${what || args.join(' ')}: exit ${r.status}: ${(r.stdout + r.stderr).split('\n').filter(Boolean).slice(0, 2).join(' | ')}`); return r; };
const setQ = (topic, st, text) => { const f = P(`greenfield/records/Q-${topic}.md`); let t = rd(f).replace(/^status:.*$/m, `status: ${st}`); if (text !== null) t = t.replace(/## Answer[\s\S]*$/, `## Answer\n${text}\n`); wr(f, t); };
const capOf = (st) => (st.next.problems[0].match(/: ([a-z0-9-]+)$/) || [])[1];
const sloppyDone = new Set();
const handlers = {
  'confirm-start': () => cli(['greenfield', 'start', '--by', 'Anna Analyst', '--yes']),
  'add-inputs': () => copy('inputs', 'inputs'),
  'explore': () => { cli(['greenfield', 'new', 'exploration']); fs.copyFileSync(path.join(fx, 'greenfield/exploration.md'), P('greenfield/exploration.md')); copy('greenfield/capabilities', 'greenfield/capabilities'); },
  'finish-exploration': () => { fs.copyFileSync(path.join(fx, 'greenfield/exploration.md'), P('greenfield/exploration.md')); copy('greenfield/capabilities', 'greenfield/capabilities'); },
  'create-questions': () => cli(['greenfield', 'new', 'questions']),
  'answer-questions': () => { for (const [topic, [st, text]] of Object.entries(answers.answers)) { const q = rd(P(`greenfield/records/Q-${topic}.md`)); if (/^status: open/m.test(q)) setQ(topic, st, st === 'assumed' ? 'Assumed, see A-design-freeform.' : st === 'asked' ? null : text); } },
  'write-assumptions': () => copyRecords('A-'),
  'wait-for-client': () => { for (const [topic, text] of Object.entries(answers.late)) setQ(topic, 'answered', text); },
  'write-understood': () => { cli(['greenfield', 'new', 'understood']); fs.copyFileSync(path.join(fx, 'greenfield/understood.md'), P('greenfield/understood.md')); },
  'approve-understood': () => cli(['greenfield', 'approve', 'understood', '--by', 'Carl Client']),
  'propose-foundation': () => { copy('changes/foundation', 'changes/foundation'); fs.copyFileSync(path.join(fx, 'glossary.md'), P('glossary.md')); },
  'finish-foundation': () => { fs.copyFileSync(path.join(fx, 'glossary.md'), P('glossary.md')); },
  'sync-foundation': () => cli(['sync', 'foundation']),
  'archive-foundation': () => cli(['archive', 'foundation']),
  'describe-sandbox': () => copy('greenfield/capabilities', 'greenfield/capabilities'),
  'propose-capability': (st) => {
    const name = capOf(st); copy(`changes/${name}`, `changes/${name}`);
    if (sloppy && name === 'billing' && !sloppyDone.has(name)) { sloppyDone.add(name); const f = P(`changes/${name}/specs/${name}.md`); wr(f, rd(f).replace(/#### Scenario: Failure:[^\n]*\n(?:(?!#{3,4} )[^\n]*\n?)*/g, '')); }
  },
  'finish-capability': (st) => { const name = capOf(st); report.recovered_mistakes++; copy(`changes/${name}`, `changes/${name}`); },
  'sync-capability': (st) => cli(['sync', capOf(st)]),
  'archive-capability': (st) => cli(['archive', capOf(st)]),
  'review-spec': () => { cli(['greenfield', 'review', 'spec', '--packet', '--out', `${S}/runs/greenfield/spec-packet.md`]); cli(['greenfield', 'review', 'spec', '--reply', path.join(fx, 'replies/spec.txt')]); },
  'signoff-spec': () => cli(['greenfield', 'approve', 'spec', '--by', 'Carl Client']),
  'plan': () => { copy('slices', 'roadmap'); if (sloppy) { const f = P('roadmap/skip-and-pause.md'); wr(f, rd(f).replace('size: L', 'size: M')); } },
  'fix-roadmap': (st) => { // follows the CLI's text: "<slice>: declares size M but needs L"
    report.recovered_mistakes++; let fixed = 0;
    for (const p of st.next.problems) { const m = p.match(/^([a-z0-9-]+): declares size ([SML]) but needs ([SML])/); if (m) { const f = P(`roadmap/${m[1]}.md`); wr(f, rd(f).replace(/^size: .*$/m, `size: ${m[3]}`)); fixed++; } }
    if (!fixed) wrong(`fix-roadmap: nothing the walker can fix from: ${st.next.problems.join(' | ').slice(0, 160)}`);
  },
  'review-plan': () => { cli(['greenfield', 'review', 'plan', '--packet', '--out', `${S}/runs/greenfield/plan-packet.md`]); cli(['greenfield', 'review', 'plan', '--reply', path.join(fx, 'replies/plan.txt')]); },
  'dry-run': () => { cli(['greenfield', 'review', 'dryrun', '--packet', '--out', `${S}/runs/greenfield/dryrun-packet.md`]); cli(['greenfield', 'review', 'dryrun', '--reply', path.join(fx, 'replies/dryrun.txt')]); },
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
