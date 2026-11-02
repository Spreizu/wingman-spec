#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# Data states of a list view (tests/fixtures/data-states, a real plan with neutral names): the 375px scenario only ever saw
# whatever the database held, the list cases were `Not visual`, and the block hid the sideways scroll its THEN ruled out.
# `lint` fails such a plan (visual-data-states, not-visual-layout) and warns about the ignore (visual-overflow-claim); the
# fixed plan (a populated state per data state, checked at 375) lints clean of all three. The rules' edge cases are Go
# tests: go test ./internal/visual -run TestDataState and ./internal/quality -run TestNotVisualLayout.
# Usage: tests/data-states.sh (needs the wingman-spec binary, see tests/lib/ws.sh, and node). Exit 0 when all pass.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/ws.sh
. "$PKG/tests/lib/ws.sh"
T="$(mktemp -d)"; [ -n "${KEEP:-}" ] || trap 'rm -rf "$T"' EXIT; [ -z "${KEEP:-}" ] || echo "kept: $T"
PASS=0; FAIL=0; rc=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; [ -z "${DEBUG:-}" ] || cat "$T/l.txt"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }

cd "$T" && mkdir p && cd p && ws_project .
ws_visual command "node app.js" && ws_visual url "http://127.0.0.1:4173/"
printf '  roles:\n    admin:\n      login: /login\n      success: /admin\n' >> "$WCFG"
C=.wingman-spec/changes/member-pauses
mkdir -p "$C/specs" && cp "$PKG/tests/fixtures/data-states/proposal.md" "$C/" && cp "$PKG/tests/fixtures/data-states/specs/admin-members.md" "$C/specs/"
printf '## 1. Members\n\n- [ ] 1.1 Members page\n  - Spec: admin-members > Members page\n  - Files: app/views/members_index.php\n  - Visual: all\n  - Done when: `true` exits 0\n' > "$C/tasks.md"

echo "== the real plan: list cases left to the database or to unit tests"
rc=0; "$WS" lint member-pauses --text > "$T/l.txt" 2>&1 || rc=$?
expect "the list view has no populated state: an error at the scenario that shows the list" '[ $rc = 1 ] && grep -q "specs/admin-members.md:15: error: visual scenario admin-members/admin-opens-the-members-page shows a list (\[data-testid=\"members-list\"\]), but no visual scenario of /admin/members shows it with data" "$T/l.txt"'
expect "a long name answered with Not visual is an error (layout needs a visual state)" 'grep -q "specs/admin-members.md:[0-9]*: error: scenario admin-members/long-firm-name-still-shows is about layout" "$T/l.txt"'
expect "Not visual stays fine for a logic case (the pause and lock labels, the empty copy)" '! grep -q "list-shows-pause-and-lock-labels is about layout" "$T/l.txt" && ! grep -q "empty-list-shows-no-paused-firms is about layout" "$T/l.txt"'
expect "ignoring the sideways scroll its THEN rules out is a warning" 'grep -q "specs/admin-members.md:30: warning: visual scenario admin-members/members-form-on-a-narrow-page says \"nothing in .#main. scrolls sideways\" but has .ignore: layout:horizontal-overflow." "$T/l.txt"'

echo "== the fixed plan: one-row, many-rows and long-name states, checked at 375"
cp "$PKG/tests/fixtures/data-states/fixed-admin-members.md" "$C/specs/admin-members.md"
rc=0; "$WS" lint member-pauses --text > "$T/l.txt" 2>&1 || rc=$?
expect "none of the three rules fires" '! grep -qE "shows a list|is about layout|horizontal-overflow" "$T/l.txt"'
sed -i 's/viewports: 375$/viewports: 1280/; s/viewports: 375, 1280$/viewports: 1280/' "$C/specs/admin-members.md"
sed -i '0,/viewports: 768, 1280/s//viewports: 375, 1280/' "$C/specs/admin-members.md"
rc=0; "$WS" lint member-pauses --text > "$T/l.txt" 2>&1 || rc=$?
expect "rows checked only wider than 480 while the view is checked at 375: an error" '[ $rc = 1 ] && grep -q "is checked at a narrow width, but only .* show it with data, all wider than 480px" "$T/l.txt"'

echo "data-states: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
