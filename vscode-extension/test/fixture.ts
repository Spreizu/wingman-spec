import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scanProject } from '../src/model/changeScanner.ts';
import { listBaseSpecNames } from '../src/model/specFiles.ts';
import type { ViewData } from '../src/webview/types.ts';
import type { Route } from '../src/webview/types.ts';

const SPEC = `## Purpose
Lets users sign in and out of the application securely.

## ADDED Requirements

### Requirement: Login <script>x</script>
The system SHALL authenticate users.

#### Scenario: valid
- **WHEN** user sends valid credentials
- **THEN** a session is created

## MODIFIED Requirements

### Requirement: Logout
The system SHALL end sessions.

#### Scenario: ok
- **WHEN** user logs out
- **THEN** the session is destroyed
`;

const BASE = `## Purpose
Base purpose that is long enough to pass the fifty character rule.

## Requirements

### Requirement: Logout
The system SHALL end the session.

#### Scenario: ok
- **WHEN** user logs out
- **THEN** cookie is cleared
`;

const ADR = (title: string, status: string, extra = '') => `---
title: ${title}
status: ${status}
date: 2026-10-19
change: demo
${extra}---

# ${title}

## Context

Because <b>reasons</b>.

## Decision

We will use it.

## Consequences

- **Positive**: fast
`;

export function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'wingman-render-'));
  const put = (rel: string, text: string): void => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  };
  put('wingman-spec.yaml', '');
  put('specs/auth.md', BASE);
  put(
    'changes/demo/proposal.md',
    '# Proposal\n\n## Why\n\nBecause users cannot sign in yet.\n\n## What Changes\n\nDo **the thing**.\n',
  );
  put('changes/demo/specs/auth.md', SPEC);
  put('changes/demo/adrs/use-it.md', ADR('Use it', 'Proposed'));
  put('changes/demo/adrs/no-decision.md', ADR('No architectural decision', 'none'));
  put('changes/demo/tasks.md', '## 1. Core\n\n- [x] 1.1 First\n  - Spec: auth > Login\n  - Test first: t\n  - Done when: d\n- [ ] 1.2 Second <img src=x onerror=alert(1)>\n  - Spec: auth > Logout\n- [ ] 1.R Review\n');
  put('changes/blocked/BLOCKED.md', '# Blocked\n\nWaiting on <i>infra</i>.\n');
  put('changes/blocked/tasks.md', '## 1. X\n\n- [ ] 1.1 Y\n');
  put('changes/shipped/tasks.md', '## 1. Core\n\n- [x] 1.1 Done\n');
  put('archive/2026-09-30-first-cut/proposal.md', '# First cut\n\nShip it.\n');
  put('archive/2026-09-30-first-cut/tasks.md', '## 1. Core\n\n- [x] 1.1 Done thing\n- [x] 1.2 Other thing\n');
  put('archive/2026-09-30-first-cut/specs/auth.md', SPEC);
  put('archive/2026-09-30-first-cut/adrs/old.md', ADR('Old', 'Accepted'));
  put('adrs/0003-standalone.md', ADR('Standalone', 'Proposed'));
  put('adrs/0001-old.md', ADR('Old', 'Superseded'));
  put('adrs/0002-new.md', ADR('New', 'Accepted', 'supersedes: 0001\n'));
  return root;
}

export async function makeData(root: string, route: Route): Promise<ViewData> {
  const project = await scanProject(root);
  const texts: Record<string, string> = {};
  const { readFileSync, readdirSync, existsSync } = await import('node:fs');
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if ((p.endsWith('.md') || p.endsWith('.jsonl')) && existsSync(p)) texts[p] = readFileSync(p, 'utf8');
    }
  };
  walk(root);
  return { projects: [project], route, texts, baseSpecs: { [project.root]: await listBaseSpecNames(root) }, setup: { commands: true, missing: [] }, actions: { trusted: true, results: {} } };
}
