#!/usr/bin/env bash
# shellcheck disable=SC2016 # single-quoted snippets are run by `bash -c`
# Smoke test: `wingman-spec init --harness all` in a temp project, the generated entry points (no hook files),
# and one Size S change from `new` to `archive` through the CLI (no agent calls).
set -uo pipefail
export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-smoke}" GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-smoke@example.invalid}"
export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-smoke}" GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-smoke@example.invalid}"
export WINGMAN_SPEC_INIT_PROBE=0

PKG="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${WINGMAN_SPEC_BIN:-}"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
if [ -z "$BIN" ]; then (cd "$PKG" && go build -o "$T/wingman-spec" ./cmd/wingman-spec) || { echo "build failed"; exit 1; }; BIN="$T/wingman-spec"; fi
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   $*"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
check() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
check_not() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then bad "$d"; else ok "$d"; fi; }

mkdir "$T/proj" && cd "$T/proj" || exit 1
git init -q && printf '{"name":"smoke","private":true,"scripts":{"test":"node --test"}}\n' > package.json

echo "== init"
"$BIN" init --harness all > "$T/init.txt" 2>&1 || bad "init exit"
check "config written"                    test -f .wingman-spec/wingman-spec.yaml
check "test command detected"             grep -q '^  test: npm test' .wingman-spec/wingman-spec.yaml
check "run state is ignored, specs are not" bash -c 'grep -qx "runs/" .wingman-spec/.gitignore && ! grep -q "specs" .wingman-spec/.gitignore'
check "shim installed and runs"           .wingman-spec/bin/wingman-spec root
check "AGENTS.md has the managed block"   grep -q 'WINGMAN-SPEC:START' AGENTS.md
for c in spec-propose spec-apply spec-sync spec-archive spec-fix spec-explore spec-adopt spec-garden spec-green-start spec-green-plan spec-green-next; do
  check "$c in Cursor, Claude Code and Codex" test -f ".cursor/commands/$c.md" -a -f ".claude/commands/$c.md" -a -f ".agents/skills/$c/SKILL.md"
done
for a in spec-implementer spec-reviewer spec-visual-reviewer; do
  check "subagent $a for Cursor and Claude Code" test -f ".cursor/agents/$a.md" -a -f ".claude/agents/$a.md"
done
check "bundled skill spec-writing"        test -f .cursor/skills/spec-writing/SKILL.md -a -f .claude/skills/spec-writing/SKILL.md -a -f .agents/skills/spec-writing/SKILL.md
check_not "no hook files written"         bash -c 'test -e .cursor/hooks.json -o -e .claude/settings.json -o -e .codex/hooks.json'
check_not "no openspec/ folder and no node scripts" bash -c 'test -e openspec || find . -name "*.cjs" -not -path "./.git/*" | grep -q .'
check_not "no box or home paths in generated files" bash -c 'grep -rlE "/(Users|workspace|home)/" .cursor .claude .agents .codex AGENTS.md'
git add -A && git commit -qm init
"$BIN" update > "$T/update.txt" 2>&1
check "update right after init changes no file" bash -c 'test -z "$(git status --porcelain)"' 

echo "== one change, new to archive"
W=.wingman-spec/bin/wingman-spec
sed -i 's/typecheck: <fill in>/typecheck: none/; s/lint: <fill in>/lint: none/' .wingman-spec/wingman-spec.yaml
check "new"                               $W new add-greeting
C=.wingman-spec/changes/add-greeting
printf 'Size: S\nRisk: none\n\n## Why\nVisitors want a greeting so the page feels personal.\n\n## What Changes\n- The home page greets the visitor by name.\n\n## Edge cases\n- none named\n' > "$C/proposal.md"
mkdir -p "$C/specs"
printf '## Purpose\nGreets a visitor by name on the home page so the page feels personal.\n\n## ADDED\n\n### Requirement: Greet by name\nThe system SHALL show "Hello, <name>" for a visitor with a name.\nWhy: Visitors want a personal page, so the greeting names them.\n\n#### Scenario: Named visitor\n- **WHEN** a visitor named Ada opens the home page\n- **THEN** the page shows "Hello, Ada"\n' > "$C/specs/greeting.md"
printf '## 1. Greeting\n\n- [ ] 1.1 Greet the visitor by name\n  - Spec: greeting > Greet by name > Named visitor\n  - Test first: test/greet.test.js\n  - Files: src/greet.js, test/greet.test.js\n  - Done when: `node --test test/greet.test.js` exits 0\n' > "$C/tasks.md"
check "validate"                          $W validate add-greeting
check "planning lint is clean"            $W lint add-greeting
git add -A && git commit -qm plan
check "next hands out task 1.1"           bash -c '"$0" next add-greeting 2>/dev/null | grep -q "\"label\": \"1.1\""' "$W"
mkdir -p src test
printf '// @spec greeting/greet-by-name\nexports.greet = (n) => `Hello, ${n}`;\n' > src/greet.js
printf "const t = require('node:test'); const a = require('node:assert'); const { greet } = require('../src/greet');\nt.test('[greeting/named-visitor] greets Ada', () => a.strictEqual(greet('Ada'), 'Hello, Ada'));\n" > test/greet.test.js
check "check passes and ticks the task"   bash -c '"$0" check add-greeting >/dev/null 2>&1 && grep -q "^- \[x\] 1.1" "$1/tasks.md"' "$W" "$C"
check "finish passes"                     bash -c '"$0" finish add-greeting 2>/dev/null | grep -qE "\"result\": \"(passed|finished)\""' "$W"
check "sync merges the living spec"       bash -c '"$0" sync add-greeting >/dev/null 2>&1 && grep -q "### Requirement: Greet by name" .wingman-spec/specs/greeting.md' "$W"
check "archive moves the change"          bash -c '"$0" archive add-greeting >/dev/null 2>&1 && ls .wingman-spec/archive | grep -q -- "-add-greeting$" && test ! -e "$1"' "$W" "$C"
check "drift is clean after archive"      $W drift

echo; echo "passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
