#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# Skipping visual defects the change does not own: `ignore:` / `ignore-http:` in a visual block and visual.ignore / visual.ignore_http in
# openspec/config.yaml. Skips are listed ("ignored (n)"), never silent; defects that are the scenario's own claim cannot be skipped, and
# unsafe values are refused. Needs openspec and node; Playwright + axe-core (PLAYWRIGHT_NODE_MODULES) for the browser part.
# Usage: tests/visual-ignore.sh. Exit 0 when all pass.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; [ -n "${KEEP:-}" ] || trap 'rm -rf "$T"' EXIT; [ -z "${KEEP:-}" ] || echo "kept: $T"
export OPENSPEC_TELEMETRY=0 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
PASS=0; FAIL=0; rc=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; [ -z "${DEBUG:-}" ] || head -c 2500 "$T/v.json" "$T/v.err" "$T/l.json" 2>/dev/null; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }

cd "$T" && mkdir p && cd p && git init -q && { openspec init --tools none >/dev/null 2>&1 || mkdir -p openspec/changes openspec/specs; }
"$PKG/install.sh" . --harness all >/dev/null || { echo "install failed"; exit 1; }
git add -A >/dev/null 2>&1; git commit -qm init >/dev/null 2>&1
V="node openspec/scripts/verify-task.cjs"
PORT="$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')"
cp "$PKG/tests/fixtures/ignore/app.js" app.js
setcfg() { # setcfg <extra visual lines>
  node -e '
const fs=require("fs"); let t=fs.readFileSync("openspec/config.yaml","utf8");
t=t.replace(/^visual:.*(\n[ \t]+.*)*\n?/m, "visual:\n  command: node app.js "+process.argv[1]+"\n  url: http://127.0.0.1:"+process.argv[1]+"/\n  ready_timeout: 20\n  screenshots: off\n"+process.argv[2]);
t=t.replace(/Test command: <fill in>/,"Test command: none").replace(/Typecheck command: <fill in>/,"Typecheck command: none").replace(/Lint command: <fill in>/,"Lint command: none");
fs.writeFileSync("openspec/config.yaml",t);' "$PORT" "$1"
}
mkchange() { # mkchange <scenario blocks>
  rm -rf openspec/changes/demo openspec/.apply-runs; mkdir -p openspec/changes/demo/specs/gallery
  printf '## Why\nSkipping defects of other teams in the visual check.\n\n## What Changes\n- Adds a gallery page.\n\n## Edge cases\n- none named\n' > openspec/changes/demo/proposal.md
  printf '## ADDED Requirements\n\n### Requirement: Gallery grid\nThe system SHALL show the result grid.\nWhy: The owner wants it to work, so that people can rely on it.\n\n%s\n' "$1" > openspec/changes/demo/specs/gallery/spec.md
  printf '## 1. Gallery\n- [ ] 1.1 Grid\n  - Spec: gallery > Gallery grid\n  - Files: app.js\n  - Visual: all\n  - Done when: `true`\n' > openspec/changes/demo/tasks.md
}
sc() { printf '#### Scenario: %s\n- **WHEN** the page is opened\n- **THEN** the grid is shown\n\n```visual\n%s\n```\n\n' "$1" "$2"; }
REPORT() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).report)' "$T/v.json"; }
setcfg ""

echo "== the grammar: every form parses, unsafe values are refused (no browser)"
parse() { node -e '
const VC=require("./openspec/scripts/visual-check.cjs");
const r=VC.parseBlock(["route: /","key: [a]",...process.argv[1].split("\n")],1);
console.log(JSON.stringify({i:r.ignores,h:r.ignore_http,e:r.errors}));' "$1"; }
expect "ignore: exact code, prefix with a trailing colon, ignore-http, repeatable, trailing comment dropped" '[ "$(parse $'"'"'ignore: a11y:color-contrast\nignore: runtime:console-error\nignore: content:   # page chrome\nignore-http: /static/images/\nignore-http: /ads/'"'"')" = "{\"i\":[\"a11y:color-contrast\",\"runtime:console-error\",\"content:\"],\"h\":[\"/static/images/\",\"/ads/\"],\"e\":[]}" ]'
for v in 'a11y:' 'runtime:' 'layout:horizontal-overflow' 'a11y:image-alt' 'runtime:http-error' 'content:broken-image'; do
  expect "ignore: $v is accepted" 'parse "ignore: $v" | grep -q "\"e\":\[\]"'
done
expect "an empty ignore is refused" 'parse "ignore:" | grep -q "empty ignore value"'
expect "a bare colon is refused" 'parse "ignore: :" | grep -q "matches nothing useful"'
expect "a quoted empty ignore-http is refused" 'parse "ignore-http:" | grep -q "empty ignore-http"'
for v in 'layout:key-missing' 'layout:key-hidden' 'layout:key-offscreen' 'layout:overlap' 'design:expect-failed' 'design:expect-unmatched' 'role:forbidden-visible' 'role:no-redirect' 'role:login-failed' 'state:step-failed' 'server:not-ready' 'regression:aria-changed'; do
  expect "ignore: $v is refused: it is the scenario's own claim" 'parse "ignore: $v" | grep -q "is refused"'
done
expect "a prefix outside a11y:, runtime:, content: is refused (layout:, design:, role:)" 'parse "ignore: layout:" | grep -q "is refused" && parse "ignore: design:" | grep -q "is refused" && parse "ignore: role:" | grep -q "is refused"'
expect "an unknown code is refused (typos do not skip nothing silently)" 'parse "ignore: runtime:consol-error" | grep -q "not a known defect code" && parse "ignore: nonsense" | grep -q "not a known defect code"'
expect "wildcards, spaces and commas in a code are refused" 'parse "ignore: a11y:*" | grep -q "no spaces, commas or wildcards" && parse "ignore: a11y:, runtime:" | grep -q "no spaces, commas or wildcards"'
expect "an ignore-http text that matches nearly everything is refused" 'parse "ignore-http: /" | grep -q "too broad" && parse "ignore-http: ab" | grep -q "too broad" && parse "ignore-http: https://" | grep -q "too broad" && parse "ignore-http: ..." | grep -q "too broad"'
expect "ignore inside a state is refused (it belongs to the whole block)" 'parse $'"'"'state: a\n  ignore: a11y:'"'"' | grep -q "belongs to the whole block"'
expect "the unknown-field message lists the new fields" 'parse "bogus: 1" | grep -q "ignore, ignore-http"'

echo "== a console error of a failed load: skipped by its own URL, else by the same skipped failure (no browser)"
cskip() { node -e '
const VC=require("./openspec/scripts/visual-check.cjs");
const rules=VC.ignoreRules({ ignores: [], ignore_http: ["/static/images/"] }, null);
const E=(code,url)=>"Failed to load resource: the server responded with a status of "+code+" ()";
const pool=JSON.parse(process.argv[2]||"[]");
const c=JSON.parse(process.argv[1]); console.log(String(VC.consoleErrorSkipped(rules,c,pool)));' "$1" "${2:-}"; }
F404='"text":"Failed to load resource: the server responded with a status of 404 ()"'
expect "a failed load whose URL matches a pattern is skipped, and the report names the pattern" 'cskip "{$F404,\"url\":\"http://x.test/static/images/a.png\"}" | grep -q "^scenario ignore-http: /static/images/, matched the URL of the console error$"'
expect "a failed load whose URL matches no pattern is reported, even when a 404 was skipped on the page" '[ "$(cskip "{$F404,\"url\":\"http://x.test/other/a.png\"}" "[{\"key\":\"404\",\"by\":\"scenario ignore-http: /static/images/\",\"what\":\"HTTP 404\"}]")" = null ]'
expect "a failed load without a URL is skipped when the page skipped a failed request with the same status" 'cskip "{$F404,\"url\":\"\"}" "[{\"key\":\"404\",\"by\":\"scenario ignore-http: /static/images/\",\"what\":\"HTTP 404\"}]" | grep -q "scenario ignore-http: /static/images/, the same failure (HTTP 404) was skipped for its request"'
expect "... for any status, and for net:: errors" 'cskip "{\"text\":\"Failed to load resource: the server responded with a status of 503 (Service Unavailable)\",\"url\":\"\"}" "[{\"key\":\"503\",\"by\":\"b\",\"what\":\"HTTP 503\"}]" | grep -q "^b, the same" && cskip "{\"text\":\"Failed to load resource: net::ERR_NAME_NOT_RESOLVED\",\"url\":\"\"}" "[{\"key\":\"net::ERR_NAME_NOT_RESOLVED\",\"by\":\"b\",\"what\":\"net::ERR_NAME_NOT_RESOLVED\"}]" | grep -q "^b, the same"'
expect "... but not when the page skipped nothing, or only a failure of another status" '[ "$(cskip "{$F404,\"url\":\"\"}")" = null ] && [ "$(cskip "{$F404,\"url\":\"\"}" "[{\"key\":\"500\",\"by\":\"b\",\"what\":\"HTTP 500\"}]")" = null ]'
expect "any other console error is skipped only when its text contains a pattern" '[ "$(cskip "{\"text\":\"widget exploded\",\"url\":\"\"}")" = null ] && cskip "{\"text\":\"cannot read /static/images/x\",\"url\":\"\"}" | grep -q "ignore-http: /static/images/"'

echo "== lint and config: the same rules, a clear error"
mkchange "$(sc 'Hide a missing key' $'route: /clean\nkey: [data-testid="grid"]\nignore: layout:key-missing')"
rc=0; $V lint demo > "$T/l.json" 2>&1 || rc=$?
expect "lint refuses an ignore of a scenario-expectation defect and names the line" '[ $rc = 1 ] && grep -q "layout:key-missing" "$T/l.json" && grep -q "is refused" "$T/l.json"'
mkchange "$(sc 'Fine' $'route: /clean\nkey: [data-testid="grid"]\nignore: a11y:\nignore-http: /ads/')"
rc=0; $V lint demo > "$T/l.json" 2>&1 || rc=$?
expect "lint has nothing to say about a block with both fields (no visual problem, no mention of ignore)" '! grep -qi "ignore" "$T/l.json" && ! grep -q "\"kind\": \"visual\"" "$T/l.json"'
setcfg "  ignore: [a11y:, runtime:console-error]
  ignore_http:
    - /static/images/
    - /ads/
"
node -e '
const VC=require("./openspec/scripts/visual-check.cjs");
' 2>/dev/null
rc=0; $V doctor > "$T/d.json" 2>&1 || rc=$?
expect "config lists (inline and one per line) are read and doctor does not complain" '! grep -q "visual.ignore" "$T/d.json"'
for bad in 'ignore: [layout:key-missing]' 'ignore: [""]' 'ignore: [":"]' 'ignore_http: ["/"]' 'ignore_http: [""]'; do
  setcfg "  $bad
"
  rc=0; $V doctor > "$T/d.json" 2>&1 || rc=$?
  expect "config $bad is a config problem" '[ $rc = 1 ] && grep -qE "visual\.ignore(_http)?" "$T/d.json"'
done
setcfg "  ignore:
"
rc=0; $V doctor > "$T/d.json" 2>&1 || rc=$?
expect "config ignore: with no values is a config problem" '[ $rc = 1 ] && grep -q "has no values" "$T/d.json"'
setcfg ""

echo "== in the browser (Playwright)"
PWM="${PLAYWRIGHT_NODE_MODULES:-}"
if [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ] && [ -d "$(dirname "$PWM")/ms-playwright" ]; then PLAYWRIGHT_BROWSERS_PATH="$(dirname "$PWM")/ms-playwright"; export PLAYWRIGHT_BROWSERS_PATH; fi
if [ -d "$PWM/playwright" ] && [ -d "$PWM/axe-core" ]; then
  ln -s "$PWM" node_modules; printf 'node_modules\n' >> .gitignore; git add -A >/dev/null 2>&1; git commit -qm cfg >/dev/null 2>&1
  run() { # run <block text> -> v.json / report
    mkchange "$(sc 'Gallery' "$1")"
    rc=0; $V visual demo > "$T/v.json" 2> "$T/v.err" || rc=$?
  }
  codes() { node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.defects.map(d=>d.code).sort().join(" "))' "$(REPORT)"; }
  ign() { node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((r.ignored||[]).map(d=>d.code+" "+d.by).sort().join("|"))' "$(REPORT)"; }
  BASE=$'route: /gallery\nviewports: 1280\nkey: [data-testid="grid"]'
  run "$BASE"
  expect "without ignores the page fails with each class: contrast, 404, console error, broken image" '[ $rc = 1 ] && c="$(codes)" && case "$c" in *a11y:color-contrast*) true;; *) false;; esac && case "$c" in *runtime:http-error*) true;; *) false;; esac && case "$c" in *runtime:console-error*) true;; *) false;; esac && case "$c" in *content:broken-image*) true;; *) false;; esac'
  run "$BASE"$'\nignore: a11y:color-contrast'
  expect "ignore: a11y:color-contrast skips exactly that rule (the rest still fails) and the skip is counted" '[ $rc = 1 ] && ! codes | grep -q "a11y:color-contrast" && codes | grep -q "runtime:http-error" && ign | grep -q "^a11y:color-contrast scenario ignore: a11y:color-contrast"'
  run "$BASE"$'\nignore: a11y:'
  expect "ignore: a11y: (prefix) skips every axe rule" '[ $rc = 1 ] && ! codes | grep -q "a11y:" && ign | grep -q "a11y:color-contrast"'
  run "$BASE"$'\nignore: a11y:image-alt'
  expect "a different rule does not skip color-contrast (exact match, no accidental skip)" '[ $rc = 1 ] && codes | grep -q "a11y:color-contrast" && [ -z "$(ign)" ]'
  run "$BASE"$'\nignore-http: /static/images/'
  expect "ignore-http skips the image 404 (request, console error, broken image) but not the /ads/ one" '[ $rc = 1 ] && c="$(codes)" && ! echo "$c" | grep -q "content:broken-image" && echo "$c" | grep -q "runtime:http-error" && ign | grep -q "runtime:http-error scenario ignore-http: /static/images/" && ign | grep -q "content:broken-image scenario ignore-http: /static/images/"'
  ST=$'route: /status\nviewports: 1280\nkey: [data-testid="grid"]'
  msgs() { node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.defects.filter(d=>d.code===process.argv[2]).map(d=>d.message).join("\n"))' "$(REPORT)" "$1"; }
  run "$ST"
  expect "without ignores every 403, 500 and 404 image leaves a console error" '[ $rc = 1 ] && [ "$(msgs runtime:console-error | grep -c "Failed to load resource")" = 3 ]'
  run "$ST"$'\nignore-http: /static/images/'
  expect "ignore-http skips the console errors of the 403 and 500 images (matched by the console message's URL), not the one of /other/" '[ $rc = 1 ] && [ "$(msgs runtime:console-error | grep -c "Failed to load resource")" = 1 ] && msgs runtime:console-error | grep -q "/other/gone.png" && ! msgs runtime:console-error | grep -q "/static/images/" && [ "$(ign | tr "|" "\n" | grep -c "^runtime:console-error scenario ignore-http: /static/images/, matched the URL of the console error$")" = 2 ]'
  expect "the console error of the non-ignored URL is still reported, with its request and image" 'msgs runtime:http-error | grep -q "HTTP 404 for GET .*/other/gone.png" && ! msgs runtime:http-error | grep -q "/static/images/" && [ "$(msgs content:broken-image | grep -c "other/gone.png")" = 1 ] && ! msgs content:broken-image | grep -q "static/images"'
  run "$ST"$'\nignore-http: /other/'
  expect "a pattern that matches another URL leaves the console errors of the 403 and 500 images reported" '[ $rc = 1 ] && [ "$(msgs runtime:console-error | grep -c "status of 403\|status of 500")" = 2 ] && [ "$(ign | tr "|" "\n" | grep -c "^runtime:console-error ")" = 1 ]'
  run "$ST"$'\nignore-http: /static/images/\nignore-http: /other/'
  expect "two patterns skip every console error and the check is clean" '[ $rc = 0 ] && [ "$(ign | tr "|" "\n" | grep -c "^runtime:console-error ")" = 3 ]'
  run "$BASE"$'\nignore-http: /static/images/'
  expect "the /ads/ console error of the other page is still reported when only the image folder is ignored" '[ $rc = 1 ] && msgs runtime:console-error | grep -q "/ads/track" && ! msgs runtime:console-error | grep -q "/static/images/"'
  run "$BASE"$'\nignore: a11y:\nignore: runtime:\nignore: content:'
  expect "all three prefixes together: the check is clean, rc 0, and the output says how many were skipped" '[ $rc = 0 ] && grep -q "\"result\": \"clean\"" "$T/v.json" && grep -q "\"ignored\": [1-9]" "$T/v.json" && grep -q "ignored_report" "$T/v.json"'
  expect "the report lists them: ignored (n): code - scenario (rule)" 'grep -q "ignored (" "$T/v.err" && grep -q "a11y:color-contrast - gallery/gallery (scenario ignore: a11y:)" "$T/v.err" && [ "$(node -e "console.log(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).ignored.length)" "$(REPORT)")" -ge 4 ]'
  run $'route: /gallery\nviewports: 1280\nkey: [data-testid="grid"]\nignore: a11y:\nignore: runtime:\nignore: content:\nignore-http: /ads/'
  expect "an ignore that matches is fine; ignores never hide a scenario that is clean (no ignored entry for /clean)" '[ $rc = 0 ]'
  run $'route: /broken\nviewports: 1280\nkey: [data-testid="grid"]\nignore: a11y:\nignore: runtime:\nignore: content:\nignore-http: /ads/'
  expect "a missing key element still fails with every skippable class ignored" '[ $rc = 1 ] && codes | grep -q "layout:key-missing"'
  run $'route: /clean\nviewports: 1280\nkey: [data-testid="grid"]\nabsent: [data-testid="grid"]\nignore: a11y:\nignore: runtime:\nignore: content:'
  expect "an absent: failure still fails with every skippable class ignored" '[ $rc = 1 ] && codes | grep -q "role:forbidden-visible"'
  run $'route: /clean\nviewports: 1280\nkey: [data-testid="grid"]\nexpect: [data-testid="grid"] font-size = 99px\nignore: a11y:\nignore: runtime:\nignore: content:'
  expect "a failed expect: still fails with every skippable class ignored" '[ $rc = 1 ] && codes | grep -q "design:"'

  echo "-- config level"
  setcfg "  ignore: [a11y:color-contrast, runtime:console-error]
  ignore_http:
    - /static/images/
    - /ads/
"
  git add -A >/dev/null 2>&1; git commit -qm cfg2 >/dev/null 2>&1
  run "$BASE"
  expect "visual.ignore and visual.ignore_http skip for every scenario: clean, listed with their config source" '[ $rc = 0 ] && ign | grep -q "config visual.ignore: a11y:color-contrast" && ign | grep -q "config visual.ignore_http: /static/images/" && ign | grep -q "config visual.ignore_http: /ads/" && ign | grep -q "config visual.ignore: runtime:console-error"'
  expect "the printed warning names the config source" 'grep -q "(config visual.ignore_http: /static/images/)" "$T/v.err"'
  run $'route: /broken\nviewports: 1280\nkey: [data-testid="grid"]'
  expect "the config cannot skip a missing key element either" '[ $rc = 1 ] && codes | grep -q "layout:key-missing"'
  mkchange "$(sc 'Gallery' "$BASE")"
  rc=0; $V next demo > "$T/n.json" 2>&1 || rc=$?; sed -i "s/- \[ \] 1.1/- [x] 1.1/" openspec/changes/demo/tasks.md; echo "// touched" >> app.js; rc=0; $V check demo > "$T/f.json" 2>&1 || rc=$?
  expect "the task-level check (next, check) treats skipped defects as not failing and prints the ignored list" '! grep -q "visual check: [0-9]* defect" "$T/f.json" && grep -q "ignored (" "$T/f.json"'
  setcfg ""
else
  echo "  skip: no Playwright+axe-core in $PWM (set PLAYWRIGHT_NODE_MODULES); the browser part of visual-ignore is not tested"
fi

echo
echo "visual-ignore: passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
