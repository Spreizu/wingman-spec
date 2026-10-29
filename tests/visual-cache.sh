#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# visual.changed_only (a visual run that passed is not repeated while the app files, scenarios, limits and pre-task capture are the same;
# a changed test or Markdown file does not matter, a changed page does) and visual.scope: task (a task is checked against its own
# scenarios; the change's other scenarios and the specs it does not change are checked at `finish`, against HEAD).
# Needs openspec and node; Playwright + axe-core (PLAYWRIGHT_NODE_MODULES) for the browser part. Usage: tests/visual-cache.sh
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; [ -n "${KEEP:-}" ] || trap 'rm -rf "$T"' EXIT; [ -z "${KEEP:-}" ] || echo "kept: $T"
export OPENSPEC_TELEMETRY=0 SPEC_TRACEABILITY=off GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
PASS=0; FAIL=0; rc=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; [ -z "${DEBUG:-}" ] || head -c 2500 "$T/v.json" "$T/v.err" 2>/dev/null; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }
cd "$T" && mkdir p && cd p && git init -q && { openspec init --tools none >/dev/null 2>&1 || mkdir -p openspec/changes openspec/specs; }
"$PKG/install.sh" . --harness all >/dev/null || { echo "install failed"; exit 1; }
git add -A >/dev/null 2>&1; git commit -qm init >/dev/null 2>&1
V="node openspec/scripts/verify-task.cjs"
PORT="$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')"
cat > app.js <<'JS'
const http = require('http'); const fs = require('fs');
http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(fs.readFileSync('page.html')); }).listen(+process.argv[2], '127.0.0.1');
JS
printf '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Gallery</title></head><body><main><h1>Gallery</h1><div data-testid="grid"><p>Items</p></div></main></body></html>\n' > page.html
node -e '
const fs=require("fs"); let t=fs.readFileSync("openspec/config.yaml","utf8");
t=t.replace(/^visual:.*(\n[ \t]+.*)*\n?/m, "visual:\n  command: node app.js "+process.argv[1]+"\n  url: http://127.0.0.1:"+process.argv[1]+"/\n  ready_timeout: 20\n  screenshots: off\n"+(process.argv[2]||""));
t=t.replace(/Test command: <fill in>/,"Test command: none").replace(/Typecheck command: <fill in>/,"Typecheck command: none").replace(/Lint command: <fill in>/,"Lint command: none");
fs.writeFileSync("openspec/config.yaml",t);' "$PORT" ""
cfg() { node -e '
const fs=require("fs"); let t=fs.readFileSync("openspec/config.yaml","utf8"); t=t.replace(/^(visual:\n(?:[ \t]+.*\n)*?)(?=[^ \t\n]|$)/m, (m)=>m.replace(/\n$/,"")+"\n"+process.argv[1]); fs.writeFileSync("openspec/config.yaml",t);' "$1"; }
vspec() { # vspec <dir> <cap> <Requirement> <Scenario> [component]
  mkdir -p "$1/$2"; printf '## ADDED Requirements\n\n### Requirement: %s\nThe system SHALL show the grid.\nWhy: The owner wants it to work, so that people can rely on it.\n\n#### Scenario: %s\n- **WHEN** the page is opened\n- **THEN** the grid is shown\n\n```visual\nroute: /\nviewports: 360\n%skey: [data-testid="grid"]\n```\n' "$3" "$4" "${5:+component: $5\n}" > "$1/$2/spec.md"; }
mkdir -p openspec/changes/demo; printf '## Why\nA page.\n\n## What Changes\n- Adds a grid.\n\n## Edge cases\n- none named\n' > openspec/changes/demo/proposal.md
vspec openspec/changes/demo/specs gallery "Gallery grid" "Grid shown"
printf '## 1. Gallery\n- [ ] 1.1 Grid\n  - Spec: gallery > Gallery grid\n  - Files: page.html\n  - Visual: all\n  - Done when: `true`\n' > openspec/changes/demo/tasks.md
git add -A >/dev/null 2>&1; git commit -qm change >/dev/null 2>&1
vrun() { rc=0; $V "$@" > "$T/v.json" 2> "$T/v.err" || rc=$?; }
hits() { grep -c "visual.changed_only" "$T/v.err"; }
cached() { ls openspec/.apply-runs/demo/cache/visual-*.json 2>/dev/null | wc -l | tr -d ' '; }

echo "== config (no browser)"
cfgp() { node -e '
const VC=require("./openspec/scripts/visual-check.cjs"); const fs=require("fs"); const f="/tmp/.vc-cfg-'$$'"; fs.writeFileSync(f,"visual:\n  command: x\n  url: http://127.0.0.1:1/\n"+process.argv[1]);
const c=VC.readLayers([f]); console.log(JSON.stringify({s:c.scope,c:c.changed_only}));' "$1"; rm -f "/tmp/.vc-cfg-$$"; }
expect "defaults: scope task, changed_only on" '[ "$(cfgp "")" = "{\"s\":\"task\",\"c\":true}" ]'
expect "scope: all and changed_only: off are read" '[ "$(cfgp $'"'"'  scope: all\n  changed_only: off\n'"'"')" = "{\"s\":\"all\",\"c\":false}" ]'

echo "== in the browser (Playwright)"
PWM="${PLAYWRIGHT_NODE_MODULES:-}"
if [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ] && [ -d "$(dirname "$PWM")/ms-playwright" ]; then PLAYWRIGHT_BROWSERS_PATH="$(dirname "$PWM")/ms-playwright"; export PLAYWRIGHT_BROWSERS_PATH; fi
if [ -d "$PWM/playwright" ] && [ -d "$PWM/axe-core" ]; then
  ln -s "$PWM" node_modules; printf 'node_modules\n' >> .gitignore; git add -A >/dev/null 2>&1; git commit -qm nm >/dev/null 2>&1
  vrun visual demo --changed-only
  expect "a clean page passes and the pass is stored (1 cache file)" '[ $rc = 0 ] && [ "$(cached)" = 1 ] && [ "$(hits)" = 0 ]'
  vrun visual demo --changed-only
  expect "the identical run is not repeated: the report says so" '[ $rc = 0 ] && [ "$(hits)" = 1 ]'
  echo "a test" > page.test.js; echo "notes" > NOTES.md; mkdir -p tests; echo "x" > tests/a.js
  vrun visual demo --changed-only
  expect "a new test file, a Markdown file and a tests/ file do not matter: still not repeated" '[ $rc = 0 ] && [ "$(hits)" = 1 ]'
  vrun visual demo
  expect "without --changed-only the default (visual.changed_only on) still skips the identical run" '[ $rc = 0 ] && [ "$(hits)" = 1 ]'
  cfg $'  changed_only: off\n'; vrun visual demo
  expect "visual.changed_only: off: the page is always checked" '[ $rc = 0 ] && [ "$(hits)" = 0 ]'
  sed -i '/changed_only: off/d' openspec/config.yaml
  printf '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Gallery</title></head><body><main><h1>Gallery</h1><div data-testid="grid"><p>More items</p></div></main></body></html>\n' > page.html
  vrun visual demo --changed-only
  expect "a changed page: checked again, stored again (2 cache files)" '[ $rc = 0 ] && [ "$(hits)" = 0 ] && [ "$(cached)" = 2 ]'
  printf '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><div data-testid="grid"><img src="/x.png"></div></body></html>\n' > page.html
  vrun visual demo --changed-only
  expect "a page with defects fails and is never stored (still 2 cache files)" '[ $rc = 1 ] && [ "$(cached)" = 2 ]'
  vrun visual demo --changed-only
  expect "so the next run checks it again and fails again" '[ $rc = 1 ] && [ "$(hits)" = 0 ]'
  git checkout -q page.html 2>/dev/null; printf '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Gallery</title></head><body><main><h1>Gallery</h1><div data-testid="grid"><p>Items</p></div></main></body></html>\n' > page.html
  SPEC_NO_CACHE=1 vrun visual demo --changed-only
  expect "SPEC_NO_CACHE=1 runs it again" '[ $rc = 0 ] && [ "$(hits)" = 0 ]'

  echo "== visual.scope: task"
  vspec openspec/specs other "Other grid" "Other grid shown" page; printf 'node_modules\n' > .gitignore; git add -A >/dev/null 2>&1; git commit -qm other >/dev/null 2>&1
  cfg $'  scope: all\n'; git add -A >/dev/null 2>&1; git commit -qm scope-all >/dev/null 2>&1
  rm -rf openspec/.apply-runs; $V next demo --session A > "$T/n.json" 2> "$T/n.err"
  printf '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Gallery</title></head><body><main><h1>Gallery</h1><div data-testid="grid"><p>Done</p></div></main></body></html>\n' > page.html
  $V check demo --reported done > "$T/c.json" 2> "$T/c.err"; rc=$?
  expect "scope: all: the task check also looks at the other spec's scenario (2 scenarios)" '[ $rc = 0 ] && grep -q "other-grid-shown" "$T/c.json"'
  git checkout -q openspec/changes/demo/tasks.md; rm -rf openspec/.apply-runs; sed -i '/scope: all/d' openspec/config.yaml; git add -A >/dev/null 2>&1; git commit -qm scope >/dev/null 2>&1
  $V next demo --session A > "$T/n.json" 2> "$T/n.err"; echo "<!-- 2 -->" >> page.html
  $V check demo --reported done > "$T/c.json" 2> "$T/c.err"; rc=$?
  expect "scope task (the default): the task check looks at its own scenario only" '[ $rc = 0 ] && ! grep -q "other-grid-shown" "$T/c.json" && grep -q "grid-shown" "$T/c.json"'
  $V finish demo > "$T/f.json" 2> "$T/f.err"; rc=$?
  expect "scope task: finish checks the scenario of the spec the change does not touch, as a guard" '[ $rc = 0 ] && grep -rq "other-grid-shown" openspec/.apply-runs/demo/*/visual/finish-*/report.json'
else
  echo "  skip: no Playwright+axe-core in $PWM (set PLAYWRIGHT_NODE_MODULES); the browser part of visual-cache is not tested"
fi
echo; echo "visual-cache: passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
