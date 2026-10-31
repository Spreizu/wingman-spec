#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# /spec-adopt "observed, unconfirmed": the verifier flags adopted requirements without a `Confirmed:` line and incomplete
# .wingman-spec/observed entries; the recorded before/after runs on tests/fixtures/adopt/helpdesk are scored mechanically against the answer key.
# The two runs were made by one agent reading the command text of the time (no API key, no independent runner): they are a regression
# fixture and a single measurement, not a benchmark. Usage: tests/adopt.sh (needs node, git, openspec). Exit 0 when every case passes.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/ws.sh
. "$PKG/tests/lib/ws.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export WINGMAN_SPEC_INSTALL_PROBE=0 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
unset OPENSPEC_ROOT OPENSPEC_PROJECT_ROOT
PASS=0; FAIL=0; rc=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }
V="$WS"
FX="$PKG/tests/fixtures/adopt"
gq() { grep "$@" >/dev/null; }
mk() { rm -rf "$1"; mkdir -p "$1"; ( cd "$1" && git init -q && "$WS" init >/dev/null && git add -A && git commit -qm init ); }
gaps() { { $V drift || true; } | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(Object.entries(r.counts||{}).map(([k,v])=>k+"="+v).sort().join(" "))'; }

echo "== verifier: adopted requirements need evidence"
P="$T/p"; mk "$P"; cd "$P" || exit; mkdir -p .wingman-spec/specs src
spec() { # spec <baseline:yes|no> <requirement extra lines...>
  { echo '# pay Specification'; echo; echo '## Purpose'; echo 'Defines how a payment is taken from a customer card at checkout.'; [ "$1" = yes ] && { echo; echo 'Baseline: adopted 2026-10-26'; }; echo; echo '## Requirements'; echo; echo '### Requirement: A payment is taken'; echo 'The system SHALL take the payment at checkout.'; echo 'Accepted: no code in this fixture'; shift; for l in "$@"; do echo "$l"; done; echo; echo '#### Scenario: paid'; echo '- **WHEN** a card is charged'; echo '- **THEN** the order is paid'; } > .wingman-spec/specs/pay.md; }
spec yes
expect "a baseline requirement without Confirmed is an advisory gap: listed, drift still exits 0" 'gaps | gq "unconfirmed-requirement=1" && $V drift >/dev/null'
expect "  and says what to add" '{ $V drift --text || true; } | gq "Confirmed: test"'
expect "  and the problems list shows it as a warning at the requirement" '$V problems --json | node -e "const r=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));const f=(r.findings||r.problems||[]).find(x=>x.code===\"unconfirmed-requirement\");process.exit(f&&f.severity===\"warning\"&&/\\.md$/.test(f.file)?0:1)"'
spec yes 'Confirmed: test test/pay.test.js: takes the payment'
expect "Confirmed: test <evidence> clears it" '! gaps | gq "unconfirmed"'
spec yes 'Confirmed: doc README.md (Payments)'
expect "Confirmed: doc clears it" '! gaps | gq "unconfirmed"'
spec yes 'Confirmed: owner Mari, 2026-10-26'
expect "Confirmed: owner clears it" '! gaps | gq "unconfirmed"'
spec yes 'Confirmed: yes'
expect "a marker that names no test, doc or owner does not count" 'gaps | gq "unconfirmed-requirement=1"'
spec yes 'Confirmed: test'
expect "a bare kind without evidence does not count" 'gaps | gq "unconfirmed-requirement=1"'
spec yes 'Why: The owner wants it to work, so that people can rely on it.'
expect "a baseline requirement that has a Why needs no Confirmed line" '! gaps | gq "unconfirmed"'
spec no
expect "a spec without the Baseline line is never flagged (nothing adopted, nothing to confirm)" '! gaps | gq "unconfirmed"'
spec yes
expect "validate accepts a spec with Baseline and Confirmed lines" 'spec yes "Confirmed: doc README.md"; $WS validate --specs >/dev/null'
spec yes
expect "an unconfirmed requirement cannot be accepted (exit 2): it is confirmed or moved to observed" 'spec yes; $V drift decide unconfirmed-requirement:pay/a-payment-is-taken --accept --note "owner confirms next week" >/dev/null 2>&1; [ $? = 2 ] && gaps | gq "unconfirmed-requirement=1"'

echo "== verifier: .wingman-spec/observed entries"
O="$T/o"; mk "$O"; cd "$O" || exit; mkdir -p .wingman-spec/observed
expect "no observed directory: no line in drift --text" '! $V drift --text | gq "observed, unconfirmed"'
cat > .wingman-spec/observed/pay.md <<'MD'
# Observed, unconfirmed: pay

Code is evidence of what happens today, not proof it is wanted. Nothing here is a requirement.

## swallowed-timeout
- Observed: a timeout from the card gateway is ignored (src/pay.js:12).
- Why unconfirmed: suspected-bug, an empty catch.
- Owner: payments lead
- To confirm: ask whether a timeout should retry or fail the order.

## dev-route
- Observed: GET /debug/cards lists tokens.
- Why unconfirmed: debug-leftover
- Owner: tech lead
MD
expect "an entry without To confirm is flagged, the complete one is not" '[ "$(gaps)" = "observed-incomplete=1" ] && $V drift | gq "observed-incomplete:pay/dev-route"'
expect "  advisory: drift exits 0 and the text counts the open entries" '$V drift >/dev/null && $V drift --text | gq "observed, unconfirmed: 2 open entries in 1 file"'
sed -i 's/^- Owner: tech lead$/- Owner: tech lead\n- To confirm: ask whether anything still calls it/' .wingman-spec/observed/pay.md
expect "completing the entry clears the gap" '[ -z "$(gaps)" ]'
sed -i 's/^- Why unconfirmed: debug-leftover$/- Why unconfirmed: looks odd/' .wingman-spec/observed/pay.md
expect "a reason outside the known kinds is flagged" 'gaps | gq "observed-incomplete=1"'
expect "an observed entry is not a requirement: validate and the requirement count ignore it" '$WS validate --specs >/dev/null 2>&1; $V drift | node -e "const r=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));process.exit(r.requirements===0?0:1)"'

echo "== documents: the command, the AGENTS block and the verifier help agree"
expect "spec-adopt names the folder, the marker lines and every kind" 'f="$PKG/harness/commands/spec-adopt.md"; for w in "observed/<capability>.md" "Baseline: adopted" "Confirmed:" contradicts-doc suspected-bug debug-leftover incidental unclear untested; do gq -F -- "$w" "$f" || { echo "missing $w"; false; }; done'
expect "the kinds drift accepts (from its help) are the kinds the command lists" 'k="$($V drift --help | sed -n "s/.*starts with one of: //p" | tr -d ".," )"; [ -n "$k" ] && for w in $k; do gq -F -- "$w" "$PKG/harness/commands/spec-adopt.md" || { echo "missing $w"; exit 1; }; done'
expect "the rendered command reaches every harness" '( cd "$P" && "$WS" init --harness all >/dev/null 2>&1 ); m=0; for f in .cursor/commands/spec-adopt.md .claude/commands/spec-adopt.md .agents/skills/spec-adopt/SKILL.md; do gq "observed/<capability>.md" "$P/$f" 2>/dev/null || m=1; done; [ $m = 0 ]'
expect "the AGENTS block and the help mention it" 'gq "observed/<capability>.md" "$PKG/harness/AGENTS.block.md" && $V drift --help | gq "observed-incomplete"'

echo "== recorded runs on the seeded sample (answer key: tests/fixtures/adopt/ANSWER-KEY.txt)"
cd "$PKG" || exit
# seed: requirement text that would encode it | observed entry slug(s) | the old run's chat summary mentions it
SEEDS='B1|exactly 100|100(\.00)? EUR or more|at least 100|discount-at-exactly-100|100.00 EUR or more
B2|ignored|swallow|still placed|failed-confirmation-email|swallowed
B3|/debug/dump|debug-dump-route|NONE
B4|nearest cent|floor|cut off|total-rounding|floor
B5|shipped order|cancel(led|ling)? (a )?shipped|cancel-shipped-order|shipped
B6|(id|ids) (starts?|of) (at )?1000|starts? at 1000|first (order )?id|order-ids-start-at-1000|NONE
B7|nope|x-powered-by|helpdesk-dev|unknown-order-body|NONE'
score() { # score <run dir> -> "req=<ids> observed=<ids> summary=<ids>"
  local d="$1" specs obs sum r="" o="" s="" id req slug note
  specs="$(cat "$d"/specs/*/spec.md)"; obs="$(cat "$d"/observed/*.md 2>/dev/null)"; sum="$(cat "$d"/SUMMARY.md 2>/dev/null)"
  while IFS='|' read -r id rest; do
    IFS='|' read -ra f <<< "$rest"; note="${f[${#f[@]}-1]}"; slugs=("${f[@]:0:${#f[@]}-1}")
    # fields: requirement patterns..., observed slug(s), summary pattern. Observed slugs contain '-', requirement patterns are the earlier ones.
    local pats=() sl=()
    for x in "${slugs[@]}"; do if [[ "$x" =~ ^[a-z0-9]+(-[a-z0-9]+)+$ ]]; then sl+=("$x"); else pats+=("$x"); fi; done
    for p in "${pats[@]}"; do if echo "$specs" | grep -Eiq -- "$p"; then r="$r $id"; break; fi; done
    for p in "${sl[@]}"; do if echo "$obs" | grep -q -- "^## $p"; then o="$o $id"; break; fi; done
    if [ "$note" != NONE ] && echo "$sum" | grep -Eiq -- "$note"; then s="$s $id"; fi
  done <<< "$SEEDS"
  echo "req=[${r# }] observed=[${o# }] summary=[${s# }]"
}
BEFORE="$(score "$FX/before")"; AFTER="$(score "$FX/after")"
echo "     before: $BEFORE"; echo "     after:  $AFTER"
expect "before: two seeded items became requirements (the debug route and the 404 text/header), none was kept in the repository" '[ "$BEFORE" = "req=[B3 B7] observed=[] summary=[B1 B2 B4 B5]" ]'
expect "after: no seeded item is a requirement and all seven are recorded as observed" '[ "$AFTER" = "req=[] observed=[B1 B2 B3 B4 B5 B6 B7] summary=[]" ]'
expect "the confirmed behavior is still there in both runs (VAT, empty order, lookup, cancel, discount over 100)" 'for d in before after; do t="$(cat $FX/$d/specs/*/spec.md)"; for w in "20% VAT" "items required" "looked up by id" "can be cancelled" "10% off|10% off the subtotal"; do echo "$t" | grep -Eq -- "$w" || { echo "$d lacks $w"; exit 1; }; done; done'
expect "after: every requirement carries a Confirmed line and every entry is complete (verifier: no unconfirmed or incomplete gap)" 'rm -rf "$T/a"; mk "$T/a"; cd "$T/a"; for f in "$FX"/after/specs/*/spec.md; do c="${f%/spec.md}"; cp "$f" ".wingman-spec/specs/${c##*/}.md"; done; cp -r "$FX/after/observed" .wingman-spec/; g="$(gaps)"; t="$({ $V drift --text || true; })"; cd "$PKG"; ! echo "$g" | gq -E "unconfirmed|incomplete" && echo "$t" | gq "10 open entries"'
expect "the sample code itself passes its tests" 'cd "$FX/helpdesk" && node --test >/dev/null 2>&1; rc=$?; cd "$PKG"; [ $rc = 0 ]'

echo; echo "adopt: $PASS passed, $FAIL failed"; [ "$FAIL" = 0 ]
