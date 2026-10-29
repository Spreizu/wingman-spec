import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeAdrSync, parseRootAdr, parseSourceAdr } from '../src/model/adrSync.ts';
import { planPromote, setHeader } from '../src/model/adrPromote.ts';
import type { FileWrite } from '../src/model/adrPromote.ts';
import { adrTemplate, slugify, today, validateAdrSlug, validateChangeName } from '../src/model/scaffold.ts';
import type { RootAdr } from '../src/model/types.ts';

const DIR = '/p/adr';

function source(slug: string, extra = '', title = 'Use PostgreSQL'): ReturnType<typeof parseSourceAdr> {
  return parseSourceAdr(slug, `/c/adrs/${slug}.md`, `---\ntitle: ${title}\nstatus: Proposed\ndate: 2026-10-19\nchange: demo\n${extra}---\n\n# ${title}\n\n## Decision\nWe will.\n`);
}

/** Applies writes to an in-memory ADR directory, like the extension does on disk. */
function apply(files: Map<string, string>, writes: FileWrite[]): void {
  for (const w of writes) files.set(w.path, w.content);
}

function rootsOf(files: Map<string, string>): RootAdr[] {
  const out: RootAdr[] = [];
  for (const [path, text] of files) {
    const adr = parseRootAdr(path.split('/').pop() ?? '', path, text);
    if (adr) out.push(adr);
  }
  return out.sort((a, b) => a.number.localeCompare(b.number));
}

test('promotes a new ADR with the next number, then is idempotent and up to date', () => {
  const files = new Map<string, string>([[`${DIR}/0001-old.md`, '---\ntitle: Old\nstatus: Accepted\ndate: 2026-01-01\nchange: x\nsource: x/old\n---\nbody\n']]);
  const src = source('use-pg');
  const plan = planPromote({ change: 'demo', sources: [src], roots: rootsOf(files), adrDir: DIR, read: (p) => files.get(p) });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.writes.map((w) => w.path).sort(), [`${DIR}/0002-use-pg.md`]);
  apply(files, plan.writes);

  const roots = rootsOf(files);
  assert.equal(computeAdrSync('demo', src, roots).state, 'up-to-date');
  assert.equal(files.has(`${DIR}/README.md`), false); // no generated index: parallel branches would conflict on it

  const again = planPromote({ change: 'demo', sources: [src], roots, adrDir: DIR, read: (p) => files.get(p) });
  assert.deepEqual(again.writes, []);
});

test('updates an out-of-date ADR in place and keeps its number', () => {
  const files = new Map<string, string>();
  const first = source('use-pg');
  apply(files, planPromote({ change: 'demo', sources: [first], roots: [], adrDir: DIR, read: (p) => files.get(p) }).writes);
  const edited = source('use-pg', '', 'Use Postgres 16');
  const plan = planPromote({ change: 'demo', sources: [edited], roots: rootsOf(files), adrDir: DIR, read: (p) => files.get(p) });
  assert.equal(plan.writes.find((w) => w.path === `${DIR}/0001-use-pg.md`)?.kind, 'update');
  apply(files, plan.writes);
  assert.equal(computeAdrSync('demo', edited, rootsOf(files)).state, 'up-to-date');
});

test('supersession marks the old ADR and keeps Superseded status on re-promotion', () => {
  const files = new Map<string, string>();
  apply(files, planPromote({ change: 'demo', sources: [source('first')], roots: [], adrDir: DIR, read: (p) => files.get(p) }).writes);
  const next = source('second', 'supersedes: 0001\n', 'Replace it');
  const plan = planPromote({ change: 'demo', sources: [next], roots: rootsOf(files), adrDir: DIR, read: (p) => files.get(p) });
  assert.deepEqual(plan.errors, []);
  apply(files, plan.writes);
  const roots = rootsOf(files);
  assert.equal(roots[0]?.status, 'Superseded by 0002');
  assert.equal(computeAdrSync('demo', next, roots).state, 'up-to-date');
  assert.deepEqual(planPromote({ change: 'demo', sources: [next], roots, adrDir: DIR, read: (p) => files.get(p) }).writes, []);
});

test('reports unfilled templates and missing supersedes targets, skips status none', () => {
  const unfilled = parseSourceAdr('u', '/c/adrs/u.md', '---\ntitle: <!-- t -->\nstatus: Proposed\ndate: <!-- d -->\n---\nbody\n');
  const none = parseSourceAdr('n', '/c/adrs/n.md', '---\ntitle: T\nstatus: none\ndate: 2026-01-01\n---\nbody\n');
  const dangling = source('d', 'supersedes: 0009\n');
  const plan = planPromote({ change: 'demo', sources: [unfilled, none, dangling], roots: [], adrDir: DIR, read: () => undefined });
  assert.equal(plan.errors.length, 2);
  assert.deepEqual(plan.writes, []);
  assert.ok(plan.notes.some((n) => n.includes('skipped')));
});

test('scaffold helpers', () => {
  assert.equal(slugify('Use PostgreSQL for persistence!'), 'use-postgresql-for-persistence');
  assert.equal(slugify('  Ünïcode — title '), 'unicode-title');
  assert.ok(validateChangeName('Bad Name', []));
  assert.ok(validateChangeName('add-auth', ['add-auth']));
  assert.equal(validateChangeName('add-auth', []), undefined);
  assert.ok(validateAdrSlug('', []));
  assert.equal(today(new Date(2026, 0, 5)), '2026-01-05');
});

test('adrTemplate produces a filled front matter, the schema sections and no supersedes line by default', () => {
  const t = adrTemplate({ title: 'Use X', change: 'demo', date: '2026-10-20' });
  const src = parseSourceAdr('use-x', '/x', t);
  assert.equal(src.fields['title'], 'Use X');
  assert.equal(src.fields['supersedes'], undefined);
  assert.equal(computeAdrSync('demo', src, []).state, 'not-promoted');
  for (const h of ['## Context', '## Decision', '## Alternatives considered', '## Consequences']) assert.ok(t.includes(h), h);
  assert.equal(parseSourceAdr('y', '/y', adrTemplate({ title: 'Y', change: 'demo', date: '2026-10-20', supersedes: '0003' })).fields['supersedes'], '0003');
});

// Byte-identical rewrites: a promoted ADR keeps what a person added, and nothing else changes.
test('setHeader changes only the named keys: comments, other keys, order, quoting, blank lines and CRLF stay', () => {
  const raw = '---\r\n# why we chose it\r\ntitle: "Use PG"\r\nstatus: Accepted   # reviewed\r\nowner: Mari\r\n\r\n---\r\nBody\r\n\r\n\r\nEnd';
  const out = setHeader(raw, [['status', 'Superseded by 0002'], ['source', 'c/x']]);
  assert.equal(out, '---\r\n# why we chose it\r\ntitle: "Use PG"\r\nstatus: Superseded by 0002\r\nowner: Mari\r\n\r\nsource: c/x\r\n---\r\nBody\r\n\r\n\r\nEnd');
  assert.equal(setHeader('no front matter\n', [['status', 'x']]), 'no front matter\n');
});

test('promotion marks a superseded ADR without touching the rest of that file, and never writes a README', () => {
  const old = '---\r\n# keep me\r\ntitle: First\r\nstatus: Accepted\r\ndate: 2026-01-01\r\nchange: x\r\nsource: x/first\r\n---\r\nOld body  with  spaces\r\n';
  const files = new Map<string, string>([[`${DIR}/0001-first.md`, old], [`${DIR}/README.md`, '# Our own notes\n\nHand-written.\n']]);
  const readme = files.get(`${DIR}/README.md`);
  const plan = planPromote({ change: 'demo', sources: [source('second', 'supersedes: 0001\n', 'Replace it')], roots: rootsOf(files), adrDir: DIR, read: (p) => files.get(p) });
  apply(files, plan.writes);
  assert.equal(files.get(`${DIR}/0001-first.md`), old.replace('status: Accepted', 'status: Superseded by 0002'));
  assert.equal(files.get(`${DIR}/README.md`), readme);
});

test('re-promoting an edited ADR keeps the header keys and comments a person added', () => {
  const files = new Map<string, string>();
  apply(files, planPromote({ change: 'demo', sources: [source('use-pg')], roots: [], adrDir: DIR, read: (p) => files.get(p) }).writes);
  const path = `${DIR}/0001-use-pg.md`;
  files.set(path, (files.get(path) ?? '').replace('---\n', '---\n# reviewed by the platform team\nowner: Mari\n'));
  const edited = source('use-pg', '', 'Use Postgres 16');
  apply(files, planPromote({ change: 'demo', sources: [edited], roots: rootsOf(files), adrDir: DIR, read: (p) => files.get(p) }).writes);
  const text = files.get(path) ?? '';
  assert.ok(text.startsWith('---\n# reviewed by the platform team\nowner: Mari\n'));
  assert.ok(text.includes('Use Postgres 16'));
  assert.equal(computeAdrSync('demo', edited, rootsOf(files)).state, 'up-to-date');
});
