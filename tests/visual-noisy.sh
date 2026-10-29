#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# A visual check on a page full of defects the task did not cause: requests that never answer must not cost a timeout per state and
# viewport (and must not hide the page's other checks), the same request or console error is reported once per viewport, visual.page_timeout
# and visual.request_timeout cap the waits, and visual.baseline: on lets a task fail only on defects that are new since it started.
# Needs openspec and node; Playwright + axe-core (PLAYWRIGHT_NODE_MODULES) for the browser part. Usage: tests/visual-noisy.sh
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; [ -n "${KEEP:-}" ] || trap 'rm -rf "$T"' EXIT; [ -z "${KEEP:-}" ] || echo "kept: $T"
export OPENSPEC_TELEMETRY=0 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
PASS=0; FAIL=0; rc=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; [ -z "${DEBUG:-}" ] || head -c 2500 "$T/v.json" "$T/v.err" 2>/dev/null; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }

cd "$T" && mkdir p && cd p && git init -q && { openspec init --tools none >/dev/null 2>&1 || mkdir -p openspec/changes openspec/specs; }
"$PKG/install.sh" . --harness all >/dev/null || { echo "install failed"; exit 1; }
git add -A >/dev/null 2>&1; git commit -qm init >/dev/null 2>&1
V="node openspec/scripts/verify-task.cjs"
PORT="$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')"
CLOSED="$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')"
cp "$PKG/tests/fixtures/noisy/app.js" app.js
setcfg() { # setcfg <extra visual lines>
  node -e '
const fs=require("fs"); let t=fs.readFileSync("openspec/config.yaml","utf8");
t=t.replace(/^visual:.*(\n[ \t]+.*)*\n?/m, "visual:\n  command: node app.js "+process.argv[1]+" "+process.argv[2]+"\n  url: http://127.0.0.1:"+process.argv[1]+"/\n  ready_timeout: 20\n  screenshots: off\n"+process.argv[3]);
t=t.replace(/Test command: <fill in>/,"Test command: none").replace(/Typecheck command: <fill in>/,"Typecheck command: none").replace(/Lint command: <fill in>/,"Lint command: none");
fs.writeFileSync("openspec/config.yaml",t);' "$PORT" "$CLOSED" "$1"
}
mkchange() {
  rm -rf openspec/changes/demo openspec/.apply-runs; mkdir -p openspec/changes/demo/specs/gallery
  printf '## Why\nA noisy page.\n\n## What Changes\n- Adds a grid.\n\n## Edge cases\n- none named\n' > openspec/changes/demo/proposal.md
  printf '## ADDED Requirements\n\n### Requirement: Gallery grid\nThe system SHALL show the grid.\nWhy: The owner wants it to work, so that people can rely on it.\n\n#### Scenario: Grid shown\n- **WHEN** the page is opened\n- **THEN** the grid is shown\n\n```visual\nroute: /\nviewports: 360, 1280\nkey: [data-testid="grid"]\nstate: open\n  do: click [data-testid="btn"]\n  key: [data-testid="panel"]\nstate: again\n  do: click [data-testid="btn"]\n  key: [data-testid="panel"]\n```\n' > openspec/changes/demo/specs/gallery/spec.md
  printf '## 1. Gallery\n- [ ] 1.1 Grid\n  - Spec: gallery > Gallery grid\n  - Files: app.js\n  - Visual: all\n  - Done when: `true`\n' > openspec/changes/demo/tasks.md
}
REPORT() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).report)' "$T/v.json"; }
RJ() { node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const a=process.argv.slice(3);console.log(eval(process.argv[2]))' "$(REPORT)" "$@"; }
vrun() { rc=0; s0=$(date +%s); $V visual demo > "$T/v.json" 2> "$T/v.err" || rc=$?; secs=$(( $(date +%s) - s0 )); }

echo "== config: the limits and the baseline switch (no browser)"
cfgp() { node -e '
const VC=require("./openspec/scripts/visual-check.cjs"); fs=require("fs"); fs.writeFileSync("/tmp/.noisy-cfg-'$$'","visual:\n  command: x\n  url: http://127.0.0.1:1/\n"+process.argv[1]);
const c=VC.readLayers(["/tmp/.noisy-cfg-'$$'"]); console.log(JSON.stringify({p:c.page_timeout,r:c.request_timeout,b:c.baseline,e:c.ignore_errors}));' "$1"; rm -f "/tmp/.noisy-cfg-$$"; }
expect "defaults: page_timeout 5, request_timeout 3, baseline off" '[ "$(cfgp "")" = "{\"p\":5,\"r\":3,\"b\":false,\"e\":[]}" ]'
expect "page_timeout, request_timeout and baseline are read" '[ "$(cfgp $'"'"'  page_timeout: 8\n  request_timeout: 1.5\n  baseline: on\n'"'"')" = "{\"p\":8,\"r\":1.5,\"b\":true,\"e\":[]}" ]'
expect "a limit that is not a number, or a page_timeout of 0, is a config problem naming the key" 'cfgp $'"'"'  page_timeout: 0\n'"'"' | grep -q "visual.page_timeout" && cfgp $'"'"'  request_timeout: soon\n'"'"' | grep -q "visual.request_timeout"'

echo "== in the browser (Playwright)"
PWM="${PLAYWRIGHT_NODE_MODULES:-}"
if [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ] && [ -d "$(dirname "$PWM")/ms-playwright" ]; then PLAYWRIGHT_BROWSERS_PATH="$(dirname "$PWM")/ms-playwright"; export PLAYWRIGHT_BROWSERS_PATH; fi
if [ -d "$PWM/playwright" ] && [ -d "$PWM/axe-core" ]; then
  ln -s "$PWM" node_modules; printf 'node_modules\nflag\n' >> .gitignore; git add -A >/dev/null 2>&1; git commit -qm cfg >/dev/null 2>&1
  mkchange; setcfg $'  request_timeout: 0\n'; vrun
  expect "request_timeout: 0, requests that never answer: the run fails (as before) but waits for them once, not once per state and viewport" '[ $rc = 1 ] && [ "$secs" -lt 14 ] && [ "$(RJ "r.defects.filter((d)=>d.code===\"state:load-failed\").length")" = 1 ] && [ "$(RJ "r.perf.aborted_known_hung")" -gt 0 ]'
  expect "the load failure names what it waits for and the checks still ran on the page (the nameless button and the overflow are found)" 'RJ "r.defects.find((d)=>d.code===\"state:load-failed\").message" | grep -q "still waiting for GET .*/hang/h" && RJ "r.defects.some((d)=>d.code===\"a11y:button-name\")&&r.defects.some((d)=>d.code===\"layout:horizontal-overflow\")" | grep -q true'
  expect "the same request or console error is reported once per viewport, not once per state" '[ "$(RJ "r.defects.filter((d)=>d.code===\"runtime:console-error\").length")" = "$(RJ "new Set(r.defects.filter((d)=>d.code===\"runtime:console-error\").map((d)=>d.viewport+d.message)).size")" ] && [ "$(RJ "r.perf.repeated_runtime_defects")" -gt 0 ]'
  setcfg $'  request_timeout: 1\n'; vrun
  expect "request_timeout: 1 aborts the hung requests at once: no load failure, and the timed-out request is reported as a failed request" '[ $rc = 1 ] && [ "$secs" -lt 10 ] && [ "$(RJ "r.defects.filter((d)=>d.code===\"state:load-failed\").length")" = 0 ] && RJ "r.defects.some((d)=>d.code===\"runtime:request-failed\"&&/hang\\/h0/.test(d.message))" | grep -q true'
  setcfg ""; vrun
  expect "the default (request_timeout 3): the hung requests are reported as failed requests, not as a load failure" '[ $rc = 1 ] && [ "$(RJ "r.defects.filter((d)=>d.code===\"state:load-failed\").length")" = 0 ] && RJ "r.defects.some((d)=>d.code===\"runtime:request-failed\"&&/hang\\/h0/.test(d.message))" | grep -q true'
  setcfg $'  page_timeout: 2\n  request_timeout: 0\n'; vrun
  expect "page_timeout: 2 is the limit of the load (the failure says 2s)" '[ $rc = 1 ] && RJ "r.defects.find((d)=>d.code===\"state:load-failed\").message" | grep -q "within 2s"'

  echo "== baseline: only what is new since the task started fails"
  rm -f flag; mkchange; git add -A >/dev/null 2>&1; git commit -qm change >/dev/null 2>&1; setcfg $'  request_timeout: 1\n'
  $V next demo --session A > "$T/n.json" 2> "$T/n.err" || true
  vrun; base_off=$(RJ "r.defects.length")
  expect "baseline off (the default): the task fails on every defect of the page, old or new" '[ $rc = 1 ] && [ "$base_off" -gt 100 ] && RJ "r.defects.some((d)=>d.code===\"runtime:console-error\")" | grep -q true'
  setcfg $'  request_timeout: 1\n  baseline: on\n'; vrun
  expect "baseline on, nothing new: the old requests, console errors and axe defects outside the grid are listed once as info and do not count; the overflow and broken images still do" '[ "$(RJ "r.baseline_defects")" -gt 50 ] && [ "$(RJ "r.defects.filter((d)=>d.code.startsWith(\"runtime:\")||d.code.startsWith(\"a11y:\")).length")" = 0 ] && RJ "r.defects.some((d)=>d.code===\"layout:horizontal-overflow\")" | grep -q true && grep -q "baseline: [0-9]* defects were already on the page" "$T/v.err"'
  touch flag; vrun
  expect "baseline on, a task that adds a nameless button inside the grid and an image that answers 404: both fail, nothing old does" '[ $rc = 1 ] && RJ "r.defects.some((d)=>d.code===\"a11y:button-name\"&&d.in_region)" | grep -q true && RJ "r.defects.some((d)=>d.code===\"runtime:http-error\"&&/new404/.test(d.message))" | grep -q true && [ "$(RJ "r.defects.filter((d)=>d.code===\"runtime:http-error\"&&!/new404/.test(d.message)).length")" = 0 ]'
  setcfg $'  request_timeout: 1\n'; vrun
  expect "baseline switched off again: back to every defect" '[ "$(RJ "r.defects.length")" -ge "$base_off" ] && [ "$(RJ "r.baseline_defects||0")" = 0 ]'
else
  echo "  skip: no Playwright+axe-core in $PWM (set PLAYWRIGHT_NODE_MODULES); the browser part of visual-noisy is not tested"
fi

echo
echo "visual-noisy: passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
