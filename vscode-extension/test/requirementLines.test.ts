import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptedOf, proposalApproval, whyOf } from '../src/model/requirementLines.ts';

test('why: the line under the SHALL sentence, before the first scenario', () => {
  assert.equal(whyOf('### Requirement: A\nThe system SHALL x.\nWhy: The account owner wants a, so that b.\n\n#### Scenario: s'), 'The account owner wants a, so that b.');
  assert.equal(whyOf('### Requirement: A\nSHALL x.\n**Why:** Staff need it.'), 'Staff need it.');
  assert.equal(whyOf('### Requirement: A\nSHALL x.\n#### Scenario: s\nWhy: after the scenario'), null);
  assert.equal(whyOf('### Requirement: A\nSHALL x.'), null);
});

test('accepted: the reason before the first scenario', () => {
  assert.equal(acceptedOf('### Requirement: A\nSHALL x.\nAccepted: covered elsewhere\n'), 'covered elsewhere');
  assert.equal(acceptedOf('### Requirement: A\nSHALL x.\n#### Scenario: s\nAccepted: no'), null);
});

test('owner approval of a proposal: the last non-empty line, fences and comments ignored', () => {
  assert.equal(proposalApproval('## Why\nx\nOwner approval: Maria, 2026-10-01\n'), 'Maria, 2026-10-01');
  assert.equal(proposalApproval('Owner approval:\n'), null);
  assert.equal(proposalApproval('```\nOwner approval: Fenced, 2026-10-01\n```\n'), null);
  assert.equal(proposalApproval('<!-- Owner approval: Hidden, 2026-10-01 -->\n'), null);
});
