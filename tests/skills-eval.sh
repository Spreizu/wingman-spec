#!/usr/bin/env bash
# First-party skills: wingman- prefix, no superpowers: prefix, ponytail is task-scoped, requesting-code-review uses review_range.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

expect "no skill names superpowers:" '! grep -R --include=SKILL.md -n "superpowers:" "$PKG/skills"'
expect "ponytail ends with the task" 'grep -q "This skill applies to this task only" "$PKG/skills/wingman-ponytail/SKILL.md"'
expect "requesting-code-review uses review_range" 'grep -q "review_range" "$PKG/skills/wingman-requesting-code-review/SKILL.md" && grep -q "Do not run git rev-parse HEAD~1" "$PKG/skills/wingman-requesting-code-review/SKILL.md"'
expect "NOTICE credits the remaining upstreams" 'grep -q "wingman-grilling" "$PKG/skills/NOTICE.md" && grep -q "mattpocock/skills" "$PKG/skills/NOTICE.md" && grep -q "DietrichGebert/ponytail" "$PKG/skills/NOTICE.md" && ! grep -q "obra/superpowers" "$PKG/skills/NOTICE.md"'
expect "spec-writing names the linter hedges" 'grep -q "as expected" "$PKG/skills/spec-writing/SKILL.md" && grep -q "gracefully" "$PKG/skills/spec-writing/SKILL.md"'
expect "forked skills use the wingman- prefix" '! test -d "$PKG/skills/ponytail" && test -d "$PKG/skills/wingman-ponytail" && test -d "$PKG/skills/wingman-grilling"'

echo; echo "passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
