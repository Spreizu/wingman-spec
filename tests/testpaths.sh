#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# Test-file detection (internal/testpaths) and the trace over one fixture per language (tests/lib/lang-fixtures.cjs):
# a tagged test in the language's conventional file name, `finish` (trace), `anchors` and the anchor guard;
# an untagged requirement is a gap. Usage: tests/testpaths.sh (needs the wingman-spec binary (tests/lib/ws.sh) and node). Exit 0 when all pass.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/ws.sh
. "$PKG/tests/lib/ws.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
PASS=0; FAIL=0; rc=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }
LIB="$PKG/tests/lib"

# the path table (tests/lib/test-path-table.json): go test ./internal/testpaths -run TestPathTable
# The extension's copy (vscode-extension/src/core/testpaths.ts) is held to the Go table by test/golden/testpaths.json.
expect "no other file keeps a language extension list or a test-path regex (Go sources and extension)" '! grep -rnE "py\|go|\(py\||test_\[\^/\]|_test\\\\\.\(" "$PKG/internal" "$PKG"/vscode-extension/src | grep -v "^$PKG/internal/testpaths/\|^$PKG/vscode-extension/src/core/testpaths.ts:"'

echo "== project with one tagged test per language"
cd "$T" && mkdir p && cd p && git init -q
ws_init .
ws_cmd test none && ws_cmd typecheck none && ws_cmd lint none && ws_set visual off
node -e '
const L = require(process.argv[1] + "/lang-fixtures.cjs"), fs = require("fs"), path = require("path");
const put = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
for (const [f, t] of Object.entries(L.files())) put(f, t);
for (const l of L.LANGS) put(`.wingman-spec/changes/langs/specs/${l.cap}.md`, L.spec(l).replace("## Requirements", "## ADDED"));
put(".wingman-spec/changes/langs/proposal.md", "Size: L\nRisk: none\n\n## Why\nGreetings are needed in every language the team writes.\n\n## Edge cases\n- none named\n\n## What Changes\n- Greets.\n\n## Capabilities\n### New Capabilities\n" + L.LANGS.map((l) => `- \`${l.cap}\`: greets`).join("\n") + "\n");
put(".wingman-spec/changes/langs/app-map.md", "## Capability inventory\n" + L.LANGS.map((l) => `- ${l.cap}`).join("\n") + "\n");
put(".wingman-spec/changes/langs/design.md", "## Decisions\nOne function per language.\n\n## Implementation guide\nOne function per language.\n\n## Pitfalls\nNone.\n");
put(".wingman-spec/changes/langs/adrs/none.md", "---\nstatus: none\n---\nNo significant decision.\n");
put(".wingman-spec/changes/langs/tasks.md", "## 1. Greet\n- [x] 1.1 greet\n  - Spec: " + L.LANGS.map((l) => `${l.cap}/works; ${l.cap}/fails`).join("; ") + "\n  - Test first: x\n  - Files: src/greet.js\n  - Done when: `true` exits 0\n");' "$LIB"
V="$WS"
git add -A && git commit -qm init
NL=$(node -e 'console.log(require(process.argv[1]+"/lang-fixtures.cjs").LANGS.length)' "$LIB")
J() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));let v=j;for(const k of process.argv[2].split(".").filter(Boolean))v=v==null?v:v[k];console.log(typeof v==="object"?JSON.stringify(v):v)' "$1" "$2"; }

echo "== trace: tags found in every language"
rc=0; $V finish langs > "$T/finish.json" 2>/dev/null || rc=$?
expect "finish: every scenario of every language has a tagged test ($(( NL * 2 ))/$(( NL * 2 )))" '[ "$(J "$T/finish.json" result)" = finished ] && node -e "const c=JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).checks.find((x)=>x.check===\"trace\");process.exit(c.scenarios===$NL*2&&c.tagged===$NL*2&&!c.untested.length?0:1)" "$T/finish.json"'
rc=0; $V anchors langs --json > "$T/anchors.json" 2>/dev/null || rc=$?
expect "anchors: every requirement has a code anchor and a test, none unresolved or stale" '[ "$(J "$T/anchors.json" summary.requirements)" = $NL ] && [ "$(J "$T/anchors.json" summary.without_code)" = "[]" ] && [ "$(J "$T/anchors.json" summary.without_test)" = "[]" ] && [ "$(J "$T/anchors.json" summary.unresolved)" = 0 ] && [ "$(J "$T/anchors.json" summary.stale_tags)" = 0 ]'
node -e '
const L = require(process.argv[1] + "/lang-fixtures.cjs"), a = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8")).index.requirements;
const bad = L.LANGS.filter((l) => { const r = a[`${l.cap}/${l.req}`]; return !r || !r.code.includes(l.src) || !r.tests.includes(l.test); }).map((l) => l.id);
console.log(bad.join(" "));' "$LIB" "$T/anchors.json" > "$T/langs-bad.txt"
expect "anchors: each language lists its source file as code and its test file as test (missing: $(cat "$T/langs-bad.txt"))" '[ -z "$(cat "$T/langs-bad.txt")" ]'
rc=0; $V problems --json > "$T/problems.json" 2>/dev/null || rc=$?
expect "problems: no error and no trace, anchor or drift finding (only the missing final review task)" '[ "$(J "$T/problems.json" counts.error)" = 0 ] && node -e "process.exit(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).findings.every((f)=>f.code===\"review\")?0:1)" "$T/problems.json"'

echo "== anchor guard: the source files of every language are read"
BASE=$(git rev-parse HEAD)
node -e '
const L = require(process.argv[1] + "/lang-fixtures.cjs"), fs = require("fs");
for (const l of L.LANGS) fs.writeFileSync(l.src, fs.readFileSync(l.src, "utf8").replace(/hi/g, "hello"));' "$LIB"
rc=0; $V guard langs --base "$BASE" --json > "$T/guard.json" 2>/dev/null || rc=$?
node -e '
const L = require(process.argv[1] + "/lang-fixtures.cjs"), g = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
console.log(L.LANGS.filter((l) => !g.files.includes(l.src)).map((l) => l.id).join(" "));' "$LIB" "$T/guard.json" > "$T/guard-bad.txt"
expect "guard: an edited anchored body is seen in every language (missing: $(cat "$T/guard-bad.txt"))" '[ -z "$(cat "$T/guard-bad.txt")" ]'
git checkout -q .

echo "== a requirement without a tagged test is a gap (PHP and Java)"
for l in php java; do
  f=.wingman-spec/changes/langs/specs/lang-$l.md
  printf '\n### Requirement: Say bye\nThe system SHALL say goodbye.\nWhy: The owner wants it to work, so that people can rely on it.\n\n#### Scenario: Waves\n- **WHEN** a user leaves\n- **THEN** the system says goodbye\n' >> "$f"
done
printf '\n// @spec lang-php/say-bye\nfunction bye(): string { return "bye"; }\n' >> src/Greet/Greet.php
printf '// @spec lang-java/say-bye\nclass Bye { static String bye() { return "bye"; } }\n' >> src/main/java/app/Greet.java
sed -i "s|^  - Spec: .*|&; lang-php/waves; lang-java/waves|" .wingman-spec/changes/langs/tasks.md
rc=0; $V finish langs > "$T/gap.json" 2>/dev/null || rc=$?
expect "finish fails and names both untagged scenarios" '[ "$(J "$T/gap.json" result)" = failed ] && grep -q "lang-php/waves" "$T/gap.json" && grep -q "lang-java/waves" "$T/gap.json" && ! grep -q "lang-go/" "$T/gap.json"'
rc=0; $V anchors langs --json > "$T/anchors2.json" 2>/dev/null || rc=$?
expect "anchors reports both new requirements as anchored in code with no test" '[ "$(J "$T/anchors2.json" summary.without_test)" = "[\"lang-java/say-bye\",\"lang-php/say-bye\"]" ] || [ "$(J "$T/anchors2.json" summary.without_test)" = "[\"lang-php/say-bye\",\"lang-java/say-bye\"]" ]'
# tag the PHP one in a PHPUnit docblock, the Java one in a @DisplayName string
sed -i 's|^    public function testFails(): void {}|&\n\n    /**\n     * [lang-php/waves] says goodbye\n     */\n    public function testWaves(): void {}|' src/Greet/GreetTest.php
sed -i 's|^  void fails() {}|&\n\n  @Test\n  @DisplayName("[lang-java/waves] says goodbye")\n  void waves() {}|' src/test/java/app/GreetTest.java
rc=0; $V finish langs > "$T/gap2.json" 2>/dev/null || rc=$?
expect "tagging them (PHPUnit docblock, JUnit @DisplayName) closes the gap" '[ "$(J "$T/gap2.json" result)" = finished ]'

echo; echo "testpaths: passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
