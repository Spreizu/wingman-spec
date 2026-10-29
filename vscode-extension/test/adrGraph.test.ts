import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adrCategory, buildAdrLinks, lineageOf, statusCounts } from '../src/model/adrGraph.ts';
import type { RootAdr } from '../src/model/types.ts';

function adr(number: string, status: string, supersedes = ''): RootAdr {
  return { number, slug: `s${number}`, path: `/adr/${number}.md`, title: `T${number}`, status, date: '', change: '', source: '', supersedes, body: '', fields: {} };
}

const ADRS = [adr('0001', 'Superseded by 0002'), adr('0002', 'Superseded', '0001'), adr('0003', 'Accepted', '0002'), adr('0004', 'Proposed'), adr('0005', '')];

test('categorises statuses and counts them', () => {
  assert.equal(adrCategory('Superseded by 0002'), 'superseded');
  assert.deepEqual(statusCounts(ADRS), { accepted: 1, proposed: 1, superseded: 2, deprecated: 0, other: 1 });
});

test('links supersedes both ways and builds the lineage oldest first', () => {
  const links = buildAdrLinks(ADRS);
  assert.equal(links.get('0002')?.supersedes?.number, '0001');
  assert.equal(links.get('0002')?.supersededBy[0]?.number, '0003');
  assert.deepEqual(lineageOf('0002', links).map((a) => a.number), ['0001', '0002', '0003']);
  assert.deepEqual(lineageOf('0004', links).map((a) => a.number), ['0004']);
});

test('cycles do not hang', () => {
  const links = buildAdrLinks([adr('0001', 'x', '0002'), adr('0002', 'x', '0001')]);
  assert.ok(lineageOf('0001', links).length <= 2);
});
