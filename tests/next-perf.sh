#!/usr/bin/env bash
# shellcheck disable=SC2016
# `next` and `check` on a large repo: 20,000 tracked files, 10,000 ignored files, a docker-style data directory that is neither
# tracked nor ignored (10,000 small files and 150 MB of binary segments). Fails when `next` takes over 3 s or `check` over 6 s, when
# the hash writes the data into .git, touches the real index, misses an edit of an untracked file, or the data counts as changed lines.
# Usage: tests/next-perf.sh (needs the wingman-spec binary (tests/lib/ws.sh), node, python3 and git on PATH; about 30 s).
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/ws.sh
. "$PKG/tests/lib/ws.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export WINGMAN_SPEC_TRACEABILITY=off GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
unset WINGMAN_SPEC_NO_CACHE WINGMAN_SPEC_CHECK_LEVEL WINGMAN_SPEC_TEST_RUN WINGMAN_SPEC_TEST_CMD WINGMAN_SPEC_TYPECHECK_CMD WINGMAN_SPEC_LINT_CMD
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
secs() { awk -v a="$1" -v b="$(date +%s.%N)" 'BEGIN{printf "%.2f", b-a}'; }
cd "$T" && mkdir p && cd p && git init -q -b main
ws_init .
python3 - <<'PY'
import os
for d in range(200):
    p=f"src/m{d}"; os.makedirs(p, exist_ok=True)
    for f in range(100): open(f"{p}/f{f}.js","w").write(f"export const v{d}_{f} = {d*f};\n"*10)
for d in range(100):
    p=f"node_modules/pkg{d}"; os.makedirs(p, exist_ok=True)
    for f in range(100): open(f"{p}/i{f}.js","w").write("x\n"*20)
PY
printf 'node_modules/\n' > .gitignore
ws_cmd test none && ws_cmd typecheck none && ws_cmd lint none && ws_set visual off
C=.wingman-spec/changes/demo; mkdir -p "$C/specs"
printf 'Size: S\nRisk: none\n\n## Why\nDemo.\n\n## What Changes\n- Adds a demo capability.\n\n## Edge cases\n- none named\n' > "$C/proposal.md"
printf '## ADDED\n\n### Requirement: Demo\nThe system SHALL greet.\nWhy: The visitor wants a greeting, so that they feel welcome.\n\n#### Scenario: greet\n- **WHEN** asked\n- **THEN** it shows "hi"\n' > "$C/specs/demo.md"
printf '## 1. Core\n- [ ] 1.1 Greet\n  - Files: src/m1/f1.js\n  - Done when: `true` exits 0\n' > "$C/tasks.md"
git add -A && git commit -qm init
sleep 1.1  # the data below is older than the change's first run
python3 - <<'PY'
import os
os.makedirs("docker/data/pg", exist_ok=True); blob=os.urandom(1<<20)
for i in range(150): open(f"docker/data/pg/seg{i}","wb").write(blob[i:]+blob[:i])
for d in range(10):
    p=f"docker/data/wal/d{d}"; os.makedirs(p, exist_ok=True)
    for f in range(1000): open(f"{p}/w{f}","w").write(f"{d}-{f}\n"*30)
PY
touch -d '1 hour ago' -- docker/data/pg/* docker/data/wal/*/*
V="$WS"
git0=$(du -sk .git | cut -f1); idx0=$(sha1sum .git/index | cut -c1-40)
echo "tracked $(git ls-files | wc -l | tr -d ' '), untracked $(git ls-files -o --exclude-standard | wc -l | tr -d ' '), $(du -sh docker | cut -f1) in docker/"
s=$(date +%s.%N); $V next demo --format prompt --session p1 >/dev/null 2>"$T/next.err"; rc=$?; t=$(secs "$s")
echo "  next: $t s"
expect "next on the large repo answers (rc=$rc)" '[ "$rc" = 0 ]'
expect "next takes under 3 s ($t s)" 'awk -v t="$t" "BEGIN{exit !(t < 3)}"'
expect "the new-run line names branch and commit, no idle minutes" 'grep -q "new run .* on main at [0-9a-f]\{8\} in " "$T/next.err" && ! grep -q "last command" "$T/next.err"'
echo "// edit" >> src/m1/f1.js; sed -i 's/- \[ \] 1.1/- [x] 1.1/' "$C/tasks.md"
s=$(date +%s.%N); $V check demo --session p1 >"$T/check.out" 2>"$T/check.err"; rc=$?; t=$(secs "$s")
echo "  check: $t s"
expect "check passes (rc=$rc)" '[ "$rc" = 0 ]'
expect "check takes under 6 s ($t s)" 'awk -v t="$t" "BEGIN{exit !(t < 6)}"'
expect "the data directory is not counted as changed lines" '! grep -q "changed lines" "$T/check.out" "$T/check.err"'
expect "the hash writes no blobs of untracked data into .git (grew $(( $(du -sk .git | cut -f1) - git0 )) KB)" '[ $(( $(du -sk .git | cut -f1) - git0 )) -lt 5000 ]'
expect "the real index is untouched" '[ "$(sha1sum .git/index | cut -c1-40)" = "$idx0" ]'
# the hash (memoised, forgotten after a command, untracked and tracked edits change it, ignored files do not):
# go test ./internal/runstate -run TestCacheTree
[ "$FAIL" = 0 ] || { cat "$T/next.err"; head -c 1500 "$T/check.out"; }
echo "next-perf: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
