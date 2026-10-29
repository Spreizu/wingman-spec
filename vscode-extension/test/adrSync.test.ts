import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeAdrSync, isSynced, parseRootAdr, parseSourceAdr } from '../src/model/adrSync.ts';
import { parseFrontMatter } from '../src/model/frontMatter.ts';

const SOURCE = `---
title: Use PostgreSQL
status: Proposed
date: 2026-10-19
change: demo
supersedes: <!-- optional: number of an existing root ADR -->
---

# Use PostgreSQL

## Decision
We will use PostgreSQL.
`;

const body = parseFrontMatter(SOURCE).body;

function root(name: string, fields: Record<string, string>, text = body) {
  const fm = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n');
  const adr = parseRootAdr(name, `/adr/${name}`, `---\n${fm}\n---\n${text}`);
  assert.ok(adr);
  return adr;
}

const PROMOTED = {
  title: 'Use PostgreSQL',
  status: 'Accepted',
  date: '2026-10-19',
  change: 'demo',
  source: 'demo/use-postgres',
};

const src = (text = SOURCE) => parseSourceAdr('use-postgres', '/c/adrs/use-postgres.md', text);

test('front matter parser reads flat keys and body', () => {
  const fm = parseFrontMatter(SOURCE);
  assert.equal(fm.fields['title'], 'Use PostgreSQL');
  assert.ok(fm.body.includes('# Use PostgreSQL'));
});

test('not promoted when no root ADR carries the source identity', () => {
  assert.equal(computeAdrSync('demo', src(), []).state, 'not-promoted');
  const other = root('0001-other.md', { ...PROMOTED, source: 'demo/other' });
  assert.equal(computeAdrSync('demo', src(), [other]).state, 'not-promoted');
});

test('up to date when the promoted file equals what sync would write', () => {
  const r = computeAdrSync('demo', src(), [root('0001-use-postgres.md', PROMOTED)]);
  assert.equal(r.state, 'up-to-date');
  assert.equal(r.target?.number, '0001');
});

test('out of date when body or title differ', () => {
  const changedBody = root('0001-use-postgres.md', PROMOTED, '\n# Use PostgreSQL\n\nold text\n');
  const a = computeAdrSync('demo', src(), [changedBody]);
  assert.equal(a.state, 'out-of-date');
  assert.match(a.detail, /body/);
  const changedTitle = root('0001-use-postgres.md', { ...PROMOTED, title: 'Old title' });
  assert.match(computeAdrSync('demo', src(), [changedTitle]).detail, /title/);
});

test('a promoted Superseded or Deprecated status is kept, not treated as drift', () => {
  const r = root('0001-use-postgres.md', { ...PROMOTED, status: 'Superseded by 0002' });
  assert.equal(computeAdrSync('demo', src(), [r]).state, 'up-to-date');
  const proposed = root('0001-use-postgres.md', { ...PROMOTED, status: 'Proposed' });
  assert.equal(computeAdrSync('demo', src(), [proposed]).state, 'out-of-date');
});

test('status none is skipped', () => {
  const none = parseSourceAdr('none', '/c/adrs/none.md', '---\ntitle: x\nstatus: None\n---\nNo decisions.\n');
  assert.equal(computeAdrSync('demo', none, []).state, 'none');
});

test('unfilled template placeholders are never promotable', () => {
  const tpl = SOURCE.replace('title: Use PostgreSQL', 'title: <!-- Short decision title -->');
  assert.equal(computeAdrSync('demo', src(tpl), []).state, 'unfilled');
  const noDate = SOURCE.replace('date: 2026-10-19', 'date: <!-- YYYY-MM-DD -->');
  assert.equal(computeAdrSync('demo', src(noDate), []).state, 'unfilled');
});

test('supersedes pointing to a missing ADR is an error', () => {
  const s = SOURCE.replace(/supersedes: .*/, 'supersedes: 0003');
  assert.equal(computeAdrSync('demo', src(s), []).state, 'error');
});

test('supersession requires the old ADR to be marked superseded', () => {
  const s = SOURCE.replace(/supersedes: .*/, 'supersedes: 0003');
  const promoted = root('0004-use-postgres.md', { ...PROMOTED, supersedes: '0003' });
  const oldAccepted = root('0003-old.md', { ...PROMOTED, source: 'x/old' });
  assert.equal(computeAdrSync('demo', src(s), [oldAccepted, promoted]).state, 'out-of-date');
  const oldMarked = root('0003-old.md', { ...PROMOTED, source: 'x/old', status: 'Superseded by 0004' });
  assert.equal(computeAdrSync('demo', src(s), [oldMarked, promoted]).state, 'up-to-date');
});

test('isSynced is true only when every ADR is up to date or skipped (status none)', () => {
  const mk = (state: 'up-to-date' | 'none' | 'unfilled' | 'error' | 'not-promoted' | 'out-of-date') => ({
    state,
    detail: '',
  });
  assert.equal(isSynced([mk('up-to-date'), mk('none')]), true);
  // /spec-sync stops on an unfilled template or a broken `supersedes`, so those are not synced.
  assert.equal(isSynced([mk('up-to-date'), mk('unfilled')]), false);
  assert.equal(isSynced([mk('error')]), false);
  assert.equal(isSynced([mk('up-to-date'), mk('not-promoted')]), false);
  assert.equal(isSynced([mk('out-of-date')]), false);
  assert.equal(isSynced([]), true);
});

test('parseRootAdr ignores README and non-numbered files', () => {
  assert.equal(parseRootAdr('README.md', '/adr/README.md', '# x'), undefined);
  assert.equal(parseRootAdr('notes.md', '/adr/notes.md', '# x'), undefined);
});
