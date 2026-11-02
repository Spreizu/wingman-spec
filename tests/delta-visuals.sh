#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# Living scenarios a change makes obsolete (tests/fixtures/delta-visuals, neutral names): the favorites list used to show
# an unavailable item as a disabled row, and the change omits it. With the old scenario under the requirement the
# delta MODIFIES, finish guards specs/ as it reads after archive, so the old scenario is gone and finish passes on the
# new page. With the old scenario under another requirement, `lint` fails (visual-stale-guard) until the delta
# MODIFIES or REMOVES that requirement too. The edge cases are Go tests: go test ./internal/visual -run TestStaleGuard
# and ./internal/verify -run TestAfterArchive.
# Usage: tests/delta-visuals.sh (needs the wingman-spec binary, see tests/lib/ws.sh, and node; Playwright + axe-core in
# PLAYWRIGHT_NODE_MODULES for the finish part). Exit 0 when all pass.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/ws.sh
. "$PKG/tests/lib/ws.sh"
T="$(mktemp -d)"; [ -n "${KEEP:-}" ] || trap 'rm -rf "$T"' EXIT; [ -z "${KEEP:-}" ] || echo "kept: $T"
export WINGMAN_SPEC_TRACEABILITY=off GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
F="$PKG/tests/fixtures/delta-visuals"
PASS=0; FAIL=0; rc=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; [ -z "${DEBUG:-}" ] || cat "$T/l.txt"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }

cd "$T" && mkdir p && cd p && ws_project .
PORT="$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')"
ws_visual command "node app.js $PORT" && ws_visual url "http://127.0.0.1:$PORT/" && ws_visual screenshots off
cat > app.js <<'JS'
const http = require('http'); const fs = require('fs');
http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(fs.readFileSync('page.html')); }).listen(+process.argv[2], '127.0.0.1');
JS
row='<li><span>Item 42</span><input class="quantity" value="1" disabled aria-label="Quantity"><button data-testid="favorite-add" disabled>Add</button></li>'
page() { printf '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Favorites</title></head><body><header><a href="/favorites" data-testid="favorites-heart">Favorites</a></header><main><h1>Favorites</h1><ul data-testid="favorites-list"><li><span>Item 7</span><button data-testid="favorite-add">Add</button></li>%s</ul></main></body></html>\n' "$1" > page.html; }
page "$row"
C=.wingman-spec/changes/omit-unavailable
mkdir -p .wingman-spec/specs "$C/specs"
cp "$F/living-favorites.md" .wingman-spec/specs/favorites.md
cp "$F/proposal.md" "$F/tasks.md" "$C/" && cp "$F/specs/favorites.md" "$C/specs/"
lint() { rc=0; "$WS" lint omit-unavailable --text > "$T/l.txt" 2>&1 || rc=$?; }

echo "== the old scenario sits under the requirement the delta modifies"
lint
expect "lint: no stale guard (the MODIFIED block drops the old scenario, as archive will)" '! grep -q "visual-stale-guard\|still requires" "$T/l.txt"'

echo "== the old scenario sits under another requirement the delta leaves alone"
sed -i '/^#### Scenario: Unavailable item shows a disabled row/i ### Requirement: Unavailable items stay listed\nThe favorites list SHALL keep an unavailable item as a disabled row.\nWhy: The shopper wants to see saved items that are out of stock, so that they can order them later.\n' .wingman-spec/specs/favorites.md
rm -f "$C/spec-base.json"
lint
expect "lint fails at the change scenario: the same WHEN is dropped, so the living requirement goes under REMOVED" '[ $rc = 1 ] && grep -q "specs/favorites.md:[0-9]*: error: visual scenario favorites/unavailable-item-is-omitted says the case is dropped (\"has no row\"), but favorites/unavailable-item-shows-a-disabled-row (specs/favorites.md:[0-9]*, requirement \"Unavailable items stay listed\") has the same WHEN" "$T/l.txt" && grep -q "under ## REMOVED (with a Reason)" "$T/l.txt" && grep -q "Not visual. is only for behaviour that still exists" "$T/l.txt"'
expect "only that scenario: the add button and the header heart are not flagged" '[ "$(grep -c "still checks the old behaviour\|still requires" "$T/l.txt")" = 1 ]'
sed -i 's/^- \*\*WHEN\*\* the shopper has item `42` saved and no warehouse has it in stock$/- **WHEN** the stock feed reports zero for item `42` in every warehouse/' .wingman-spec/specs/favorites.md
lint
expect "another WHEN: the absent: selector the living scenario still requires is the error" '[ $rc = 1 ] && grep -q "says .absent: input.quantity. on /favorites, but favorites/unavailable-item-shows-a-disabled-row (specs/favorites.md:[0-9]*, requirement \"Unavailable items stay listed\") still requires .input.quantity\[disabled\]. there" "$T/l.txt" && ! grep -q "visual-dropped\|has the same WHEN" "$T/l.txt"'
printf '\n## REMOVED\n\n### Requirement: Unavailable items stay listed\n**Reason**: unavailable items are omitted now.\n**Migration**: none.\n' >> "$C/specs/favorites.md"
rm -f "$C/spec-base.json"
lint
expect "a REMOVED block for that requirement clears it" '! grep -q "still requires\|has the same WHEN" "$T/l.txt"'
cp "$F/specs/favorites.md" "$C/specs/"; cp "$F/living-favorites.md" .wingman-spec/specs/favorites.md; rm -f "$C/spec-base.json"

echo "== finish (Playwright)"
PWM="${PLAYWRIGHT_NODE_MODULES:-}"
if [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ] && [ -d "$(dirname "$PWM")/ms-playwright" ]; then PLAYWRIGHT_BROWSERS_PATH="$(dirname "$PWM")/ms-playwright"; export PLAYWRIGHT_BROWSERS_PATH; fi
if [ -d "$PWM/playwright" ] && [ -d "$PWM/axe-core" ]; then
  ln -s "$PWM" node_modules; printf 'node_modules\n' >> .gitignore
  git add -A >/dev/null 2>&1; git commit -qm base >/dev/null 2>&1
  mkdir -p "$C/adrs"; echo "# App map" > "$C/app-map.md"; echo "# Design" > "$C/design.md"; echo "No ADR." > "$C/adrs/none.md"
  page ""; sed -i "s/- \[ \] 1.1/- [x] 1.1/" "$C/tasks.md"
  fin() { rc=0; "$WS" finish omit-unavailable > "$T/f.json" 2> "$T/f.err" || rc=$?; cp "$T/f.json" "$T/l.txt"; }
  fin
  expect "the page without the disabled row passes: the old scenario is not guarded" '[ $rc = 0 ] && ! grep -rq "unavailable-item-shows-a-disabled-row" .wingman-spec/runs/omit-unavailable/*/visual/finish-*/report.json && grep -rq "heart-shows-in-the-header" .wingman-spec/runs/omit-unavailable/*/visual/finish-*/report.json'
  sed -i 's/^### Requirement: List shows availability$/### Requirement: No such requirement/' "$C/specs/favorites.md"; rm -rf .wingman-spec/runs "$C/spec-base.json"
  fin
  expect "a delta that does not merge: finish fails and says the living scenarios are not guarded" '[ $rc != 0 ] && grep -q "are not guarded: the delta specs do not merge" "$T/f.json"'
else
  echo "  skip: no Playwright+axe-core in $PWM (set PLAYWRIGHT_NODE_MODULES); the finish part is not tested"
fi
echo "delta-visuals: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
