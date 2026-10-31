#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# Time of change and archive: `archive` records archived_at (ISO 8601 with offset, to the second) and, when known, created_at
# in the archived folder. The ordering rules are Go tests (see below).
# Usage: tests/chronology.sh (needs the wingman-spec binary, see tests/lib/ws.sh, git and node). Exit 0 when all pass.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/ws.sh
. "$PKG/tests/lib/ws.sh"
T="$(mktemp -d)"; [ -n "${KEEP:-}" ] || trap 'rm -rf "$T"' EXIT; [ -z "${KEEP:-}" ] || echo "kept: $T"
unset WINGMAN_SPEC_TRACEABILITY WINGMAN_SPEC_ANCHOR_GUARD WINGMAN_SPEC_ANCHOR_STALE WINGMAN_SPEC_ANCHOR_PLACEMENT WINGMAN_SPEC_TEST_EVIDENCE
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
PASS=0; FAIL=0; rc=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }

echo "== archive writes archived.json"
cd "$T" && mkdir p && cd p && git init -q
ws_init .
ws_cmd test none && ws_cmd typecheck none && ws_cmd lint none && ws_set visual off
V="$WS"
mkdir -p .wingman-spec/changes/alpha/specs .wingman-spec/specs
cat > .wingman-spec/changes/alpha/proposal.md <<'MD'
Size: S
Risk: none

## Why
People want a list.

## What Changes
- A list.
MD
printf '## Requirements\n\n### Requirement: Keep\nThe system SHALL keep a list.\nWhy: The owner wants it to work, so that people can rely on it.\n\n#### Scenario: Kept\n- **WHEN** x\n- **THEN** y\n' > .wingman-spec/specs/todo.md
cp .wingman-spec/specs/todo.md .wingman-spec/changes/alpha/specs/todo.md; sed -i 's/^## Requirements/## ADDED/' .wingman-spec/changes/alpha/specs/todo.md
printf '## 1. A\n\n- [x] 1.1 Done\n' > .wingman-spec/changes/alpha/tasks.md
mkdir -p src tests; printf '/**\n * Keeps the list.\n * @spec todo/keep\n */\nexport function keepList(items) {\n  return items.slice();\n}\n' > src/list.js
printf 'import { test } from "node:test";\ntest("[todo/kept] kept", () => {});\n' > tests/list.test.js
git add -A && git commit -qm init
before=$(date +%s)
rc=0; $V archive alpha > "$T/ar.json" 2> "$T/ar.err" || rc=$?
AD=$(ls -d .wingman-spec/archive/*-alpha 2>/dev/null | head -1)
expect "archive records archived_at in the archived folder: ISO 8601 with offset, to the second" '[ -n "$AD" ] && [ -f "$AD/archived.json" ] && node -e "const j=JSON.parse(require(\"fs\").readFileSync(process.argv[1]+\"/archived.json\",\"utf8\"));process.exit(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(j.archived_at)&&Math.abs(Date.parse(j.archived_at)/1000-$before)<120?0:1)" "$AD"'
expect "the answer of archive carries the same time" 'grep -q "\"archived_at\": \"20" "$T/ar.json"'
expect "created_at is recorded when it is known (here: the first commit of the change folder)" 'grep -q "\"created_at\": \"20" "$AD/archived.json"'

# The order of archives (archived_at, offsets, ties, the name as fallback), the replay of archived deltas in that order and
# the local ISO time: go test ./internal/trace -run TestArchive; go test ./internal/timeline -run TestIsoLocal
echo
echo "chronology: passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
