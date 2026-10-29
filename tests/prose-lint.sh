#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# scripts/prose-lint.cjs: each rule fires on a seeded sentence and stays quiet on a clean one; code fences, tables,
# YAML keys and quoted words are skipped; --strict fails only on a sentence above 60 words; the shipped prose has none.
# Usage: tests/prose-lint.sh   (needs node)
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"; L="node $PKG/scripts/prose-lint.cjs"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0; rc=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }
lint() { rc=0; $L "$@" > "$T/o" 2>&1 || rc=$?; }
w() { printf 'w%.0s ' $(seq "$1"); }   # w N: N words

printf '# Title\n\nThe list shows 3 invoices. Run `lint` and read its output.\n' > "$T/clean.md"
lint "$T/clean.md"
expect "a short concrete text has no warning (exit 0)" '[ $rc = 0 ] && grep -q "prose-lint: 0 warnings" "$T/o"'

printf 'A %s end.\n' "$(w 33)" > "$T/s30.md"; lint "$T/s30.md"
expect "a 35-word sentence: sentence-30" 'grep -q "sentence-30: 35 words" "$T/o"'
printf 'A %s end.\n' "$(w 48)" > "$T/s45.md"; lint "$T/s45.md"
expect "a 50-word sentence: sentence-long, still exit 0" '[ $rc = 0 ] && grep -q "sentence-long: 50 words" "$T/o"'
printf 'A %s end.\n' "$(w 63)" > "$T/s60.md"; lint "$T/s60.md"
expect "a 65-word sentence: sentence-hard, exit 0 without --strict" '[ $rc = 0 ] && grep -q "^warn! .*sentence-hard: 65 words" "$T/o"'
lint --strict "$T/s60.md"
expect "--strict fails on a sentence above 60 words" '[ $rc = 1 ]'
lint --strict "$T/s45.md"
expect "--strict passes a 50-word sentence" '[ $rc = 0 ]'

printf 'The page (the list) shows rows (three of them).\n' > "$T/p.md"; lint "$T/p.md"
expect "two parentheses in one sentence: parens" 'grep -q "parens: 2 parentheses" "$T/o"'
printf 'The page (which is the list that the owner asked for in the first meeting last year) shows rows.\n' > "$T/pl.md"; lint "$T/pl.md"
expect "a 15-word parenthesis: paren-long" 'grep -q "paren-long: a 15-word parenthesis" "$T/o"'
printf 'It runs; it stops; it ends.\n' > "$T/sc.md"; lint "$T/sc.md"
expect "two semicolons: semicolons" 'grep -q "semicolons:" "$T/o"'
printf 'The system handles errors gracefully and shows the appropriate message.\n' > "$T/v.md"; lint "$T/v.md"
expect "vague words are named with a fix" 'grep -q "\"gracefully\": name the result" "$T/o" && grep -q "\"appropriate\": name the value" "$T/o"'
printf 'Do not write "gracefully" or "appropriate" in a THEN line.\n' > "$T/vq.md"; lint "$T/vq.md"
expect "a quoted word is a mention, not a use" 'grep -q "prose-lint: 0 warnings" "$T/o"'

{ printf '| a | %s |\n|---|---|\n\n```\n%s.\n```\n' "$(w 70)" "$(w 70)"; printf -- '---\ndescription: "Short."\n---\nBody.\n'; } > "$T/skip.md"; lint "$T/skip.md"
expect "table rows and code fences are skipped" 'grep -q "prose-lint: 0 warnings" "$T/o"'
printf -- '---\nname: x\ndescription: "A %s end."\n---\nBody.\n' "$(w 48)" > "$T/fm.md"; lint "$T/fm.md"
expect "front matter: only the description is prose, and it is linted on its own" 'grep -q "fm.md:3 sentence-long" "$T/o"'
printf 'key: value\nlist:\n  - %s\nrule: x  # A short comment.\n' "'Rules are kept and linted, really.'" > "$T/c.yaml"; lint "$T/c.yaml"
expect "YAML: keys skipped, quoted rule strings linted" 'grep -q "\"really\": delete it" "$T/o" && ! grep -q "key: value" "$T/o"'
mkdir -p "$T/templates"; printf -- '- **WHEN** <!-- an action -->\n- **THEN** <!-- the value, e.g. "3 rows" -->\n' > "$T/templates/spec.md"; lint "$T/templates/spec.md"
expect "a template WHEN/THEN comment without an example value: placeholder (one with a quoted value passes)" 'grep -q "spec.md:1 placeholder" "$T/o" && ! grep -q "spec.md:2 placeholder" "$T/o"'

lint --metrics "$T/s45.md" "$T/clean.md"
expect "--metrics prints one row per area" 'grep -q "^area | sentences" "$T/o"'
lint --json "$T/v.md"
expect "--json is valid JSON with findings" 'node -e "const j=JSON.parse(require(\"fs\").readFileSync(process.argv[1]));process.exit(j.findings.length?0:1)" "$T/o"'

# The optional user-side check: verify-task lint reports a vague THEN as info (quality.cjs thenLint).
mkdir -p "$T/ch/specs/billing"
printf '## ADDED Requirements\n\n### Requirement: Invoices\nThe system SHALL list invoices.\n\n#### Scenario: Overdue\n- **WHEN** an invoice is overdue\n- **THEN** it is handled gracefully\n- **AND** the list works as expected\n- **THEN** the row shows "Overdue"\n- **THEN** the total is 3 rows\n- **THEN** the grid is shown\n<!-- - **THEN** it works -->\n' > "$T/ch/specs/billing/spec.md"
node -e 'const r=require(process.argv[1]+"/project-template/openspec/scripts/quality.cjs").thenLint(process.argv[2]);console.log(JSON.stringify(r))' "$PKG" "$T/ch" > "$T/o"
expect "vague THEN/AND lines are info findings with the fix; quoted values, numbers, plain results and comments pass" 'node -e "const r=JSON.parse(require(\"fs\").readFileSync(process.argv[1]));process.exit(r.length===2&&r.every((x)=>x.severity===\"info\"&&x.kind===\"vague-then\")&&r[0].line===8&&r[1].line===9&&/Name the result/.test(r[0].text)?0:1)" "$T/o"'

lint --strict
expect "the shipped prose has no sentence above 60 words" '[ $rc = 0 ]'
lint
expect "the default file set skips the vendored skills" '! grep -q "skills/\(grilling\|ponytail\|test-driven-development\|systematic-debugging\|requesting-code-review\|verification-before-completion\)/" "$T/o"'
expect "the default file set includes the first-party skills" 'grep -q "in [0-9]* files" "$T/o" && node -e "process.exit(require(\"$PKG/scripts/prose-lint.cjs\").defaultFiles().some((f)=>f.includes(\"spec-writing\"))?0:1)"'

echo; echo "passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
