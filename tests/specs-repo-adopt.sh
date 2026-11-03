#!/usr/bin/env bash
# A specs repository with a linked code repo: `mode` counts the code repo's source (brownfield, not greenfield), lists it
# as a code repo, allows /spec-adopt in the specs repo and in the linked code repo, and keeps the greenfield commands
# out of the linked repo. Usage: tests/specs-repo-adopt.sh (WINGMAN_SPEC_BIN: the CLI to test).
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/ws.sh
. "$PKG/tests/lib/ws.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
PASS=0; FAIL=0; rc=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*  (rc=$rc)"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
mkdir -p "$T/specs" "$T/web/src" "$T/api"
(cd "$T/specs" && git init -q && "$WS" init --layout specs >/dev/null 2>&1)
(cd "$T/web" && git init -q && "$WS" init --layout link --specs ../specs >/dev/null 2>&1)

out=$(cd "$T/specs" && "$WS" mode 2>&1); rc=$?
expect "no code in any repo: the specs repo is greenfield" '[[ $out == "mode: greenfield"* ]]'

for i in $(seq 1 40); do echo "export const v$i = $i;"; done > "$T/web/src/cart.ts"
out=$(cd "$T/specs" && "$WS" mode --for adopt 2>&1); rc=$?
expect "a sibling repo linked with specs: makes the specs repo brownfield" '[ $rc = 0 ] && grep -q "mode: brownfield" <<<"$out" && grep -q "../web/src/cart.ts" <<<"$out"'
expect "mode lists the linked repo as a code repo" 'grep -q "code repos: ../web" <<<"$out"'
out=$(cd "$T/specs" && "$WS" mode --for start 2>&1); rc=$?
expect "/spec-green-start is refused in the specs repo once linked code exists" '[ $rc = 6 ] && grep -q "brownfield" <<<"$out"'

out=$(cd "$T/web" && "$WS" mode --for adopt 2>&1); rc=$?
expect "the linked code repo may adopt" '[ $rc = 0 ] && grep -q "mode: brownfield" <<<"$out"'
out=$(cd "$T/web" && "$WS" mode --for start 2>&1); rc=$?
expect "the greenfield commands stay in the specs repo" '[ $rc = 6 ] && grep -q "unsupported layout" <<<"$out"'

rm "$T/web/.wingman-spec/wingman-spec.yaml"
printf 'repos:\n  api: ../api\n' >> "$T/specs/wingman-spec.yaml"
for i in $(seq 1 40); do echo "package api // $i"; done > "$T/api/main.go"
out=$(cd "$T/specs" && "$WS" mode --json 2>&1); rc=$?
expect "a repos: entry counts as well (and an unlinked sibling does not)" 'grep -q "\"brownfield\"" <<<"$out" && grep -q "\"../api\"" <<<"$out" && ! grep -q "\"../web\"" <<<"$out"'

echo "specs-repo-adopt: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
