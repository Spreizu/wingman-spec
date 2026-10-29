import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A small project: a spec with 4 requirements (3 with a Why), code and tests with good and broken anchors, one pending change. */
export function traceProject(opts: { mode?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'wsx-trace-'));
  const put = (f: string, text: string): void => {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  };
  put('openspec/config.yaml', `schema: wingman-spec\ntraceability: ${opts.mode ?? 'on'}\n`);
  put(
    'openspec/specs/billing/spec.md',
    `## Purpose
Billing of items for a user, long enough to be a purpose.

## Requirements

### Requirement: Add an item
The system SHALL add an item to the bill.
Why: Users see what they owe, so they trust the app.

#### Scenario: Add and see it
- **WHEN** a user adds an item
- **THEN** it is listed

#### Scenario: Reject empty
- **WHEN** the name is empty
- **THEN** it is refused

### Requirement: Remove an item
The system SHALL remove an item.
Why: Users can remove a mistake before they pay.

#### Scenario: Remove it
- **WHEN** a user removes an item
- **THEN** it is gone

### Requirement: Rounding
The system SHALL round to cents.
Why: Finance needs totals that match the bank statement.
Accepted: covered elsewhere

#### Scenario: Half up
- **WHEN** the amount is 1.005
- **THEN** it is 1.01

### Requirement: Legacy thing
The system SHALL keep a legacy behavior.

#### Scenario: Old
- **WHEN** x
- **THEN** y
`,
  );
  put('src/add.ts', '// @spec billing/add-an-item\n// @spec billing/add-item\nexport const add = 1;\n');
  put('src/round.py', '# @spec billing/rounding\n');
  put('tests/add.test.ts', "// @spec billing/add-an-item\nit('refuses [billing/reject-empty]', () => {});\nit('old [billing/gone]', () => {});\nit('other [shipping/x]', () => {});\nit('legacy [legacy/x]', () => {});\n");
  put('openspec/changes/archive/2026-01-02-drop-legacy/specs/legacy/spec.md', '## REMOVED Requirements\n\n### Requirement: Legacy x\n');
  put('openspec/changes/archive/2026-01-01-legacy/specs/legacy/spec.md', '## ADDED Requirements\n\n### Requirement: Legacy x\nThe system SHALL do x.\n\n#### Scenario: X\n- **WHEN** a\n- **THEN** b\n');
  put('openspec/changes/refunds/proposal.md', `## Why\nRefunds.\n\n## What Changes\n- x\n`);
  put(
    'openspec/changes/refunds/specs/billing/spec.md',
    `## ADDED Requirements\n\n### Requirement: Refund an item\nThe system SHALL refund.\nWhy: Users want their money back quickly when an item is wrong.\n\n#### Scenario: Refund it\n- **WHEN** a user asks\n- **THEN** money returns\n\n### Requirement: Fee\nThe system SHALL charge a fee.\n\n#### Scenario: Fee\n- **WHEN** a\n- **THEN** b\n\n## MODIFIED Requirements\n\n### Requirement: Remove an item\nThe system SHALL remove an item until it is paid.\nWhy: Users can remove a mistake until the order is paid.\n\n#### Scenario: Remove it\n- **WHEN** a user removes an item\n- **THEN** it is gone\n\n## REMOVED Requirements\n\n### Requirement: Legacy thing\n`,
  );
  put('openspec/changes/archive/2026-01-01-first/proposal.md', '## Why\nold\n');
  put('openspec/changes/archive/2026-01-01-first/specs/billing/spec.md', '## ADDED Requirements\n\n### Requirement: Lost one\nThe system SHALL vanish.\nWhy: Nobody needs it any more, so it vanished.\n\n#### Scenario: s\n- **WHEN** a\n- **THEN** b\n');
  return dir;
}
