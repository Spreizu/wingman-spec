#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2034 # expectations are single-quoted on purpose (run later by eval)
# Design-contract tests: design-system discovery, the design map lint (every referenced element mapped, with a
# source; arbitrary values only as recorded gaps), expect: syntax and tokens, the token lint on changed UI code,
# the deterministic expect: checks in the browser, and the reviewer's side-by-side with a cited rubric.
# Usage: tests/design-contract.sh   (needs openspec, node, python3; the browser part needs Playwright, see below).
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap '[ -n "${KEEP:-}" ] || rm -rf "$T"' EXIT
export SPEC_TRACEABILITY=off OPENSPEC_TELEMETRY=0 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
PASS=0; FAIL=0; DCAUGHT=0; DTOTAL=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; [ -z "${DEBUG:-}" ] || { cat "$T/l.json" 2>/dev/null | head -c 3000; echo; }; fi; }
dfault() { DTOTAL=$((DTOTAL+1)); if eval "$2"; then DCAUGHT=$((DCAUGHT+1)); ok "design fault caught: $1"; else bad "design fault missed: $1  (rc=$rc)"; fi; }

cd "$T" && mkdir p && cd p && git init -q
openspec init --tools none >/dev/null 2>&1 || mkdir -p openspec/changes openspec/specs
"$PKG/install.sh" . >/dev/null || { echo "install failed"; exit 1; }
sed -i.b 's/Test command: <fill in>/Test command: none/' openspec/config.yaml && rm -f openspec/config.yaml.b
V="node openspec/scripts/verify-task.cjs"
C=openspec/changes/demo

# The project's design system: semantic CSS tokens (different from stock values) and a small UI kit.
mkdir -p site src/ui
cat > site/theme.css <<'CSS'
:root { --color-primary: #3b5bdb; --color-fg: #1f2433; --color-surface: #ffffff; --spacing-gutter: 32px; --radius-card: 14px; --text-title: 28px; }
body { margin: 0; font-family: sans-serif; color: var(--color-fg); }
CSS
cat > src/ui/UiButton.vue <<'VUE'
<script setup lang="ts">
withDefaults(defineProps<{ variant?: 'primary' | 'secondary'; block?: boolean }>(), { variant: 'primary', block: false });
</script>
<template><button :data-variant="variant"><slot /></button></template>
VUE
# a solid-colour PNG as the design image (any picture works for the lint; the reviewer gets it side by side)
png() { node -e '
  const zlib = require("zlib"), fs = require("fs"); const [f, w, h] = [process.argv[1], +process.argv[2], +process.argv[3]];
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(w).fill([59, 91, 219]).flat())]);
  fs.writeFileSync(f, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk("IEND", Buffer.alloc(0))]));' "$1" "$2" "$3"; }
git add -A && git commit -qm init

echo "== design-system discovery"
out="$($V design-system 2>&1)"; rc=$?
expect "design-system lists the CSS tokens and the UI kit with its variants" '[ $rc = 0 ] && printf "%s" "$out" | grep -q -- "--color-primary" && printf "%s" "$out" | grep -q "UiButton (src/ui/UiButton.vue) \[shared\]  variant: primary|secondary"'
out="$($V design-system --format json 2>&1)"; rc=$?
expect "design-system --format json is machine-readable" '[ $rc = 0 ] && printf "%s" "$out" | node -e "const j=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));process.exit(j.tokens.some(t=>t.name===\"spacing-gutter\"&&t.norm===\"32px\")?0:1)"'

DSPEC='## Purpose
The app shows its page header exactly as the designer drew it.

## ADDED Requirements

### Requirement: Page header
The system SHALL show the page header as designed.

#### Scenario: Page header
- **WHEN** the home page is opened
- **THEN** the title and the call to action match design/page-1280.png

```visual
route: /
viewports: 375, 1280
component: index
reference: design/page-1280.png @1280
reference: design/page-375.png @375
key: [data-testid="title"]
key: [data-testid="cta"]
expect: [data-testid="cta"] background-color ~ token:color-primary
expect: [data-testid="title"] font-size ~ token:text-title
expect: [data-testid="title"] font-weight = 700
expect: [data-testid="title"] line-height ~ 36px
expect: [data-testid="cta"] font-size ~ 16px
expect: [data-testid="cta"] font-weight = 600
expect: [data-testid="cta"] line-height ~ 24px
expect: [data-testid="title"] left-with [data-testid="cta"]
expect: [data-testid="title"] above [data-testid="cta"]
```'
DMAP='# Design map: demo
Inputs: design/page-1280.png (1280px), design/page-375.png (375px)

## Map
| Region / element | Selector | Implemented with | Source | Expect |
|---|---|---|---|---|
| Title | `[data-testid="title"]` | h1 font-size var(--text-title) | token: --text-title | font-size ~ token:text-title; font-weight = 700; line-height ~ 36px |
| Call to action | `[data-testid="cta"]` | UiButton variant=primary | component: UiButton | background-color ~ token:color-primary; font-size ~ 16px; font-weight = 600; line-height ~ 24px |

## Gaps
- none

## Questions for the designer
- none'
DT='- [ ] 1.1 Page header
  - Spec: app > Page header
  - Files: site/index.html
  - Visual: app/page-header
  - Done when: `true`'
reset_design() { # reset_design [spec] [map|-] [tasks]
  rm -rf "$C" openspec/.apply-runs; mkdir -p "$C/specs/app" "$C/design"
  printf 'Size: M\nRisk: none\n\n## Why\nDesign contract tests.\n\n## What Changes\n- Adds the page header from the design.\n\n## Edge cases\n- none named\n' > "$C/proposal.md"
  printf '%s\n' "${1:-$DSPEC}" > "$C/specs/app/spec.md"; printf '%s\n' "${3:-$DT}" > "$C/tasks.md"
  [ "${2:-}" = - ] || printf '%s\n' "${2:-$DMAP}" > "$C/design-map.md"
  png "$C/design/page-1280.png" 320 200; png "$C/design/page-375.png" 120 200
  printf '## Capability inventory\n- app\n' > "$C/app-map.md"; printf '## Decisions\nOne.\n\n## Implementation guide\nOne function.\n' > "$C/design.md"
  mkdir -p "$C/adrs"; printf -- '---\nstatus: none\n---\nNo decision.\n' > "$C/adrs/none.md"
}
lint() { rc=0; $V lint demo > "$T/l.json" 2>&1 || rc=$?; }

echo "== design map lint"
reset_design; lint
expect "a complete design map passes lint" '[ $rc = 0 ]'
expect "openspec validate --strict ignores design-map.md in the change" 'openspec validate demo --strict >/dev/null 2>&1'
reset_design "$DSPEC" -; lint
dfault "a referenced scenario without design-map.md fails lint" '[ $rc = 1 ] && grep -q "design-map.md is missing" "$T/l.json"'
reset_design "$DSPEC" "$(printf '%s\n' "$DMAP" | grep -v 'data-testid=\\"cta\\"\|Call to action')"; lint
dfault "a key element without a map row fails lint" '[ $rc = 1 ] && grep -q "cta.*has no row in" "$T/l.json"'
reset_design "$DSPEC" "${DMAP/component: UiButton/whatever}"; lint
dfault "a map row without a valid source fails lint" '[ $rc = 1 ] && grep -q "use token | component | framework | arbitrary" "$T/l.json"'
reset_design "$DSPEC" "${DMAP/| UiButton variant=primary | component: UiButton |/| button bg-[#3a5ad9] | arbitrary |}"; lint
dfault "an arbitrary value without a gap entry fails lint (no silent invention)" '[ $rc = 1 ] && grep -q "arbitrary value without a gap entry" "$T/l.json"'
reset_design "$DSPEC" "$(printf '%s\n' "${DMAP/| UiButton variant=primary | component: UiButton |/| button bg-[#3a5ad9] | arbitrary |}" | sed 's/^- none$/- Call to action: the design blue #3a5ad9 is not a token (closest --color-primary); question for the designer: use primary?/')"; lint
expect "the same arbitrary value recorded under Gaps passes" '[ $rc = 0 ]'
reset_design "$DSPEC" "${DMAP/| UiButton variant=primary | component: UiButton |/| button bg-blue-600 | framework |}"; lint
expect "a framework palette colour while the project has colour tokens is reported (warning)" '[ $rc = 1 ] && grep -q "uses the framework colour bg-blue-600" "$T/l.json"'
reset_design "${DSPEC/token:color-primary/token:color-brand}"; lint
dfault "expect naming an unknown token fails lint" '[ $rc = 1 ] && grep -q "the project defines no --color-brand" "$T/l.json"'
reset_design "${DSPEC/left-with/lines-up-with}"; lint
dfault "an unreadable expect line fails lint" '[ $rc = 1 ] && grep -q "cannot read expect" "$T/l.json"'
reset_design "${DSPEC/above \[data-testid=\"cta\"\]/above [data-testid=\"cta\"] @768}"; lint
dfault "an expect viewport filter matching none of the scenario viewports fails lint" '[ $rc = 1 ] && grep -q "matches none of the scenario" "$T/l.json"'
reset_design "${DSPEC/token:text-title/28px}"; lint
expect "a raw value equal to a token is accepted with a hint to use the token" '[ $rc = 0 ] && grep -q "prefer token:text-title" "$T/l.json"'
reset_design "${DSPEC/reference: design\/page-375.png @375/reference: design/missing-375.png @375}"; lint
expect "every reference image must exist" '[ $rc = 1 ] && grep -q "missing-375.png.. not found" "$T/l.json"'
reset_design "$DSPEC" "${DMAP/; font-weight = 700; line-height ~ 36px/}"; lint
dfault "a text row without font-weight and line-height in the map fails lint" '[ $rc = 1 ] && grep -q "text element ..Title.. has no font-weight, line-height" "$T/l.json"'
reset_design "$(printf '%s\n' "$DSPEC" | grep -v 'title.. line-height')"; lint
dfault "a map Expect fact the specs do not carry fails lint" '[ $rc = 1 ] && grep -q "line-height ~ 36px, but no expect: line checks .data-testid=..title... line-height" "$T/l.json"'
reset_design "$DSPEC" "$(printf '%s\n' "$DMAP" | sed 's/^| Call to action .*$/&\n| Footer note | `[data-testid=\"note\"]` | p text-sm | framework: text-sm | font-size ~ 14px; font-weight = 400; line-height ~ 20px |/')"; lint
dfault "a map row with no expect: line in the specs fails lint" '[ $rc = 1 ] && grep -q "Footer note.*has no expect: line in the specs" "$T/l.json"'

echo "== token lint on changed UI code (check)"
TICK1='n=$(grep -nE "^[-*] \[ \]" "$F" | head -1 | cut -d: -f1); sed -i.b "${n}s/\[ \]/[x]/" "$F"; rm -f "$F.b"'
orch() { # orch <stub>: next -> stub implementer -> check; sets rc, out
  $V next demo >/dev/null 2>&1 || { rc=$?; out="next exited $rc"; return; }
  F="$C/tasks.md" bash -c "$1"; out="$($V check demo --reported done 2>&1)"; rc=$?
}
good_page() { cat > site/index.html <<'HTML'
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plans</title>
<link rel="stylesheet" href="theme.css">
<style>main{padding:var(--spacing-gutter)} h1{font-size:var(--text-title);font-weight:700;line-height:36px;margin:0 0 var(--spacing-gutter)} .cta{background:var(--color-primary);color:var(--color-surface);border:0;padding:12px 20px;border-radius:var(--radius-card);font-size:16px;font-weight:600;line-height:24px}</style></head>
<body><main><h1 data-testid="title">Plans</h1><button class="cta" data-testid="cta">Choose a plan</button></main></body></html>
HTML
}
good_page; git add -A; git commit -qm page >/dev/null
reset_design; orch "$TICK1"
expect "control: no UI change, no token findings (visual off): task passes" '[ $rc = 0 ]'
reset_design; orch "sed -i.b 's#<button class=\"cta\"#<button class=\"cta bg-[\#3b5bdb]\"#' site/index.html; rm -f site/index.html.b; $TICK1"
dfault "an arbitrary class equal to a project token is rejected (use the token)" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "hard-codes #3b5bdb, which is the project token --color-primary"'
git checkout -q site/
reset_design; orch "sed -i.b 's#<button class=\"cta\"#<button style=\"color: \#3b5bdb\" class=\"cta\"#' site/index.html; rm -f site/index.html.b; $TICK1"
dfault "a raw hex equal to a project token is rejected" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "project token --color-primary"'
git checkout -q site/
reset_design; orch "sed -i.b 's#<button class=\"cta\"#<button class=\"cta bg-sky-500 p-[13px]\"#' site/index.html; rm -f site/index.html.b; $TICK1"
expect "stock palette classes and other arbitrary values only warn" '[ $rc = 0 ] && printf "%s" "$out" | grep -q "design tokens: .*bg-sky-500" && printf "%s" "$out" | grep -q "design tokens: .*p-\[13px\]"'
git checkout -q site/
reset_design; orch "sed -i.b 's#<button class=\"cta\" data-testid=\"cta\">#<button class=\"cta\" aria-label=\"Pick a plan now\" data-testid=\"cta\">#' site/index.html; rm -f site/index.html.b; $TICK1"
expect "aria-label on a button with visible text: check warns (accessible name must contain the visible text), task still passes" '[ $rc = 0 ] && printf "%s" "$out" | grep -q "accessible name: site/index.html:[0-9]*: <button> has aria-label=..Pick a plan now.. and visible text ..Choose a plan.." && printf "%s" "$out" | grep -q "explicit space"'
git checkout -q site/
reset_design; orch "sed -i.b 's#<button class=\"cta\" data-testid=\"cta\">Choose a plan</button>#<button class=\"cta\" data-testid=\"cta\">Choose a plan<span class=\"sr-only\">\&nbsp;for your team</span></button><button aria-label=\"Close\"><span aria-hidden=\"true\">x</span></button>#' site/index.html; rm -f site/index.html.b; $TICK1"
expect "... but not visually hidden extra text, or an aria-label on an icon-only button" '[ $rc = 0 ] && ! printf "%s" "$out" | grep -q "accessible name:"'
git checkout -q site/
reset_design "$DSPEC" "$(printf '%s\n' "$DMAP" | sed '0,/^- none$/s//- Call to action: padding p-[13px] has no spacing token; question for the designer: 12 or 14px?/')"
orch "sed -i.b 's#<button class=\"cta\"#<button class=\"cta p-[13px]\"#' site/index.html; rm -f site/index.html.b; $TICK1"
expect "an arbitrary value recorded under Gaps is not reported" '[ $rc = 0 ] && ! printf "%s" "$out" | grep -q "p-\[13px\]"'
git checkout -q site/; git add -A; git commit -qm t >/dev/null 2>&1

echo "== design expectations in the browser (Playwright)"
PWM="${PLAYWRIGHT_NODE_MODULES:-}"
if [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ] && [ -d "$(dirname "$PWM")/ms-playwright" ]; then PLAYWRIGHT_BROWSERS_PATH="$(dirname "$PWM")/ms-playwright"; export PLAYWRIGHT_BROWSERS_PATH; fi
if [ -d "$PWM/playwright" ] && [ -d "$PWM/axe-core" ] && command -v python3 >/dev/null; then
  PORT=$(( 4700 + $$ % 200 ))
  node -e '
    const fs = require("fs"), [f, port] = process.argv.slice(1);
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^visual: off.*$/m, `visual:\n  command: python3 -m http.server ${port} --bind 127.0.0.1 --directory site\n  url: http://127.0.0.1:${port}/\n  ready_timeout: 20\n  screenshots: off`));' openspec/config.yaml "$PORT"
  ln -s "$PWM" node_modules; printf 'node_modules\n' >> .gitignore; git add -A; git commit -qm visual >/dev/null
  reset_design; orch "$TICK1"
  expect "control: the page matches every expect: line at 375 and 1280 (exit 0)" '[ $rc = 0 ]'
  efault() { # efault <name> <page edit (sed)> <text the defect must contain>
    want="$3"; reset_design; orch "sed -i.b '$2' site/index.html; rm -f site/index.html.b; $TICK1"
    dfault "$1" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "design:expect" && printf "%s" "$out" | grep -qF -- "$want" && grep -q "^- \[ \] 1.1" "$C/tasks.md"'
    [ -z "${DEBUG:-}" ] || printf '%s\n' "$out" | grep -m2 'design:expect' | sed 's/^/      /'
    git checkout -q site/
  }
  efault "wrong colour (stock green instead of the primary token)" 's#background:var(--color-primary)#background:\#2f9e44#' 'background-color ~ token:color-primary'
  efault "wrong type size (title 20px instead of token:text-title)" 's#font-size:var(--text-title)#font-size:20px#' 'font-size ~ token:text-title'
  efault "wrong order (button before the title)" 's#<h1 data-testid="title">Plans</h1><button class="cta" data-testid="cta">Choose a plan</button>#<button class="cta" data-testid="cta">Choose a plan</button><h1 data-testid="title">Plans</h1>#' 'above'
  efault "misaligned title (indented 40px)" 's#margin:0 0 var(--spacing-gutter)}#margin:0 0 var(--spacing-gutter) 40px}#' 'left-with'
  reset_design "${DSPEC/expect: \[data-testid=\"title\"\] above \[data-testid=\"cta\"\]/expect: [data-testid=\"title\"] gap-to [data-testid=\"cta\"] ~ token:spacing-gutter}"; orch "sed -i.b 's#margin:0 0 var(--spacing-gutter)}#margin:0 0 8px}#' site/index.html; rm -f site/index.html.b; $TICK1"
  dfault "wrong spacing (8px gap instead of token:spacing-gutter)" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "the gap is 8px"'
  git checkout -q site/
  reset_design "${DSPEC/above \[data-testid=\"cta\"\]/above [data-testid=\"cta\"]
state: narrow
  do: wait 1
  expect: [data-testid=\"cta\"] border-radius ~ token:radius-card @375}"; orch "sed -i.b 's#border-radius:var(--radius-card)#border-radius:2px#' site/index.html; rm -f site/index.html.b; $TICK1"
  dfault "a state-level expect with a viewport filter is checked only there" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "narrow @ 375px" && ! printf "%s" "$out" | grep -q "narrow @ 1280px.*border-radius"'
  git checkout -q site/

  echo "== where block-level and state expects apply"
  # A page whose state can remove the call to action, and a panel that only a click shows.
  cat > "$T/state.html" <<'HTML'
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plans</title>
<link rel="stylesheet" href="theme.css">
<style>main{padding:var(--spacing-gutter)} h1{font-size:var(--text-title);font-weight:700;line-height:36px;margin:0 0 var(--spacing-gutter)} .cta{background:var(--color-primary);color:var(--color-surface);border:0;padding:12px 20px;border-radius:var(--radius-card);font-size:16px;font-weight:600;line-height:24px} .tools{margin-top:24px} [data-testid="panel"]{margin-top:16px}</style></head>
<body><main><h1 data-testid="title">Plans</h1><button class="cta" data-testid="cta">Choose a plan</button>
<div class="tools"><button data-testid="hide-cta" onclick="document.querySelector('[data-testid=cta]').remove()">Hide offer</button> <button data-testid="open-panel" onclick="document.querySelector('[data-testid=panel]').hidden=false">Details</button></div>
<div data-testid="panel" hidden>All plans include support.</div></main></body></html>
HTML
  SSPEC='## Purpose
The app shows its page header and lets the visitor hide the offer.

## ADDED Requirements

### Requirement: Page header
The system SHALL show the page header and hide the offer on request.

#### Scenario: Page header
- **WHEN** the home page is opened, or the offer is hidden
- **THEN** the title stays and the call to action is above the tools

```visual
route: /
viewports: 375, 1280
component: index
key: [data-testid="title"]
expect: [data-testid="title"] above [data-testid="cta"]
expect: [data-testid="cta"] background-color ~ token:color-primary
EXTRA
state: no-offer
  do: click [data-testid="hide-cta"]
  key: [data-testid="hide-cta"]
  expect: [data-testid="title"] above [data-testid="hide-cta"]
STATE2
```'
  sspec() { s="${SSPEC/EXTRA/$1}"; printf '%s\n' "${s/STATE2/$2}"; }
  reset_design "$(sspec '' '')" -; orch "cp '$T/state.html' site/index.html; $TICK1"
  expect "a block-level expect is not inherited by a state that removes its element (loaded page only): passes" '[ $rc = 0 ]'
  [ -z "${DEBUG:-}" ] || printf '%s\n' "$out" | grep -m3 'design:expect' | sed 's/^/      /'
  git checkout -q site/
  reset_design "$(sspec '' '  expect: [data-testid="cta"] font-size ~ 16px')" -; orch "cp '$T/state.html' site/index.html; $TICK1"
  dfault "a state-level expect is checked strictly in its state (element gone there -> defect)" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "no-offer @ 375/1280px.*font-size ~ 16px.*is not visible" && ! printf "%s" "$out" | grep -q "on the loaded page.*background-color"'
  git checkout -q site/
  reset_design "$(sspec '' '')" -; orch "cp '$T/state.html' site/index.html; sed -i.b 's#background:var(--color-primary)#background:\#2f9e44#' site/index.html; rm -f site/index.html.b; $TICK1"
  dfault "a block-level expect still fails on the loaded page (all states have steps: probed before the first state's steps)" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "on the loaded page (before the steps of this state)" && printf "%s" "$out" | grep -q "background-color ~ token:color-primary"'
  git checkout -q site/
  reset_design "$(sspec 'expect: [data-testid="panel"] left-with [data-testid="title"]' 'state: details
  do: click [data-testid="open-panel"]
  key: [data-testid="panel"]')" -; orch "cp '$T/state.html' site/index.html; $TICK1"
  expect "a block-level expect whose element appears only in a state is checked in that state (passes)" '[ $rc = 0 ]'
  git checkout -q site/
  reset_design "$(sspec 'expect: [data-testid="panel"] left-with [data-testid="title"]' 'state: details
  do: click [data-testid="open-panel"]
  key: [data-testid="panel"]')" -; orch "cp '$T/state.html' site/index.html; sed -i.b 's#\[data-testid=\"panel\"\]{margin-top:16px}#[data-testid=\"panel\"]{margin:16px 0 0 40px}#' site/index.html; rm -f site/index.html.b; $TICK1"
  dfault "... and fails there when it does not hold" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "details @ 375/1280px.*left edges differ by 40px"'
  git checkout -q site/
  reset_design "$(sspec 'expect: [data-testid="nowhere"] left-with [data-testid="title"]' '')" -; orch "cp '$T/state.html' site/index.html; $TICK1"
  dfault "a block-level expect whose elements no state shows is a defect (checked nothing)" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "design:expect-unmatched\|checked nothing"'
  git checkout -q site/

  echo "== reviewer: side by side with the design, cited rubric"
  sed -i.b 's/^  screenshots: off$/  review: subagent/' openspec/config.yaml && rm -f openspec/config.yaml.b; git add -A; git commit -qm shots >/dev/null
  reset_design; orch "$TICK1"
  rp="$(printf "%s" "$out" | sed -n -E 's/^ *"review_prompt": "(.*)",?$/\1/p')"
  expect "clean design task: deterministic checks pass, review pending (exit 5)" '[ $rc = 5 ] && [ -f "$rp" ]'
  sbs="$(find "$(dirname "$rp")" -name "*.vs-design.png" | sort)"
  expect "one side-by-side image per viewport (rendered area next to the design for that width)" '[ "$(printf "%s\n" "$sbs" | grep -c .)" = 2 ] && printf "%s" "$sbs" | grep -q "default@375.vs-design.png" && printf "%s" "$sbs" | grep -q "default@1280.vs-design.png"'
  expect "the side-by-side image is wider than the rendered area (both pictures in one image)" 'node -e "const fs=require(\"fs\");const w=(f)=>fs.readFileSync(f).readUInt32BE(16);const s=process.argv[1];process.exit(w(s)>w(s.replace(\".vs-design\",\"\"))+100?0:1)" "$(printf "%s\n" "$sbs" | tail -1)"'
  expect "review prompt lists the design references, the side-by-side images, the design map and the design rubric" 'grep -q "side by side with the design: .*vs-design.png" "$rp" && grep -q "page-375.png (@375)" "$rp" && grep -q "Design map (what each region is built with)" "$rp" && grep -q "## Design rubric (app/page-header)" "$rp" && grep -q "RUBRIC: <scenario id> <item>: pass|fail" "$rp"'
  echo "STATUS: pass" > "$T/rev.txt"; rc=0; $V review demo --reply "$T/rev.txt" > "$T/rev.out" 2>&1 || rc=$?
  dfault "a pass without the design rubric is not recorded (exit 2)" '[ $rc = 2 ] && grep -q "design rubric is incomplete" "$T/rev.out" && grep -q "no RUBRIC line for app/page-header layout" "$T/rev.out"'
  for i in layout hierarchy spacing colour typography components; do echo "RUBRIC: app/page-header $i: pass - ok"; done > "$T/rev.txt"; echo "STATUS: pass" >> "$T/rev.txt"
  rc=0; $V review demo --reply "$T/rev.txt" > "$T/rev.out" 2>&1 || rc=$?
  dfault "rubric lines without a citation are not recorded (exit 2)" '[ $rc = 2 ] && grep -q "has no citation" "$T/rev.out"'
  for i in layout hierarchy spacing colour typography components; do echo "RUBRIC: app/page-header $i: pass - rendered $i matches the design at 375 and 1280"; done > "$T/rev.txt"
  sed -i 's/^RUBRIC: app\/page-header colour: pass/RUBRIC: app\/page-header colour: fail/' "$T/rev.txt"; echo "STATUS: pass" >> "$T/rev.txt"
  rc=0; $V review demo --reply "$T/rev.txt" > "$T/rev.out" 2>&1 || rc=$?
  dfault "a failed rubric item with STATUS: pass and no DEFECT is not recorded (exit 2)" '[ $rc = 2 ] && grep -q "fails but STATUS is pass" "$T/rev.out"'
  sed -i 's/^STATUS: pass$/DEFECT: app\/page-header [default @ 1280px]: the button is green -> primary blue as in the design\nSTATUS: fail/' "$T/rev.txt"
  rc=0; $V review demo --reply "$T/rev.txt" > "$T/rev.out" 2>&1 || rc=$?
  expect "a cited rubric fail with its DEFECT rejects the task like a failing test (exit 1)" '[ $rc = 1 ] && grep -q "the button is green" "$T/rev.out" && grep -q "^- \[ \] 1.1" "$C/tasks.md"'
  orch "$TICK1"; sed -i 's/colour: fail/colour: pass/; /^DEFECT/d; s/^STATUS: fail/STATUS: pass/' "$T/rev.txt"
  rc=0; $V review demo --reply "$T/rev.txt" > "$T/rev.out" 2>&1 || rc=$?
  expect "a complete cited rubric passes the task and is logged per item" '[ $rc = 0 ] && grep -q "\"rubric\":\[\"app/page-header layout:pass\"" openspec/.apply-runs/demo/*/metrics.jsonl'
  reset_design "$DSPEC" "" "$DT"; sed -i '/^reference:/d' "$C/specs/app/spec.md"; orch "$TICK1"
  rp="$(printf "%s" "$out" | sed -n -E 's/^ *"review_prompt": "(.*)",?$/\1/p')"
  echo "STATUS: pass" > "$T/rev.txt"; rc2=0; $V review demo --reply "$T/rev.txt" > "$T/rev.out" 2>&1 || rc2=$?
  expect "without a design reference: no side-by-side, no design rubric, plain review as before" '[ $rc = 5 ] && ! find "$(dirname "$rp")" -name "*.vs-design.png" | grep -q . && ! grep -q "Design rubric" "$rp" && [ $rc2 = 0 ]'
else
  echo "  skip: no Playwright+axe-core in $PWM (set PLAYWRIGHT_NODE_MODULES); browser checks not tested"
fi

echo; echo "passed=$PASS failed=$FAIL design_faults=$DCAUGHT/$DTOTAL"
[ "$FAIL" = 0 ]
