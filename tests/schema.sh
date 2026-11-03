#!/usr/bin/env bash
# CLI JSON from drift, problems and trace carries schema_version: 1.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/ws.sh
. "$PKG/tests/lib/ws.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

ws_init "$T"
cd "$T" || exit 1
mkdir -p .wingman-spec/specs
printf '%s\n' '## Purpose' 'Billing lists invoices for staff who chase overdue ones first.' '' '### Requirement: List' 'The system SHALL list invoices newest first.' 'Why: Staff chase overdue invoices first.' '' '#### Scenario: Open' '- **WHEN** the page opens' '- **THEN** the list shows 0 rows' > .wingman-spec/specs/billing.md

has_version() {
  local out
  out=$("$WS" "$1" --json 2>/dev/null || true)
  echo "$out" | node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(0,"utf8")); if (j.schema_version!==1) process.exit(1);'
}

expect "drift JSON has schema_version 1" 'has_version drift'
expect "problems JSON has schema_version 1" 'has_version problems'
expect "trace JSON has schema_version 1" 'has_version trace'
expect "schema files parse as JSON" 'node -e "const fs=require(\"fs\"),p=require(\"path\"),d=\"$PKG/schemas\"; for (const f of fs.readdirSync(d)) JSON.parse(fs.readFileSync(p.join(d,f),\"utf8\"));"'
is_sarif() {
  local out
  out=$("$WS" drift --format sarif 2>/dev/null || true)
  echo "$out" | node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(0,"utf8")); if (j.version!=="2.1.0" || !j.runs) process.exit(1);'
}
expect "drift --format sarif is a SARIF log" 'is_sarif'

echo; echo "passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
