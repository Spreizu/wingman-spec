#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# Time of change and archive (openspec/scripts/chronology.cjs): `archive` records archived_at (ISO 8601 with offset, to the second) in the archived
# folder; archives of one day order by that time, not by name; folders without the file fall back to the commit time, the mtime, the date of the
# name; the replay of archived deltas uses the same order; run ids and records are read as times.
# Usage: tests/chronology.sh (needs openspec, git and node). Exit 0 when all pass.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; [ -n "${KEEP:-}" ] || trap 'rm -rf "$T"' EXIT; [ -z "${KEEP:-}" ] || echo "kept: $T"
unset SPEC_TRACEABILITY SPEC_ANCHOR_GUARD SPEC_ANCHOR_STALE SPEC_ANCHOR_PLACEMENT SPEC_TEST_EVIDENCE
export OPENSPEC_TELEMETRY=0 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
PASS=0; FAIL=0; rc=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }
SC="$PKG/project-template/openspec/scripts"
CH="$SC/chronology.cjs"
js() { node -e "const C=require('$CH');$1"; }

echo "== archive writes archived.json"
cd "$T" && mkdir p && cd p && git init -q
openspec init --tools none >/dev/null 2>&1 || mkdir -p openspec/changes openspec/specs
"$PKG/install.sh" . --harness all >/dev/null || { echo "install failed"; exit 1; }
sed -i 's/Test command: <fill in>/Test command: none/;s/Typecheck command: <fill in>/Typecheck command: none/;s/Lint command: <fill in>/Lint command: none/;s/^visual:.*/visual: off/;/^  command: <fill in>/d;/^  url: <fill in>/d' openspec/config.yaml
V="node openspec/scripts/verify-task.cjs"
mkdir -p openspec/changes/alpha/specs/todo openspec/specs/todo
cat > openspec/changes/alpha/proposal.md <<'MD'
Size: S
Risk: none

## Why
People want a list.

## What Changes
- A list.
MD
printf 'schema: wingman-spec\ncreated: 2026-10-20\n' > openspec/changes/alpha/.openspec.yaml
printf '## Requirements\n\n### Requirement: Keep\nThe system SHALL keep a list.\nWhy: The owner wants it to work, so that people can rely on it.\n\n#### Scenario: Kept\n- **WHEN** x\n- **THEN** y\n' > openspec/specs/todo/spec.md
cp openspec/specs/todo/spec.md openspec/changes/alpha/specs/todo/spec.md; sed -i 's/^## Requirements/## ADDED Requirements/' openspec/changes/alpha/specs/todo/spec.md
printf '## 1. A\n\n- [x] 1.1 Done\n' > openspec/changes/alpha/tasks.md
mkdir -p src tests; printf '/**\n * Keeps the list.\n * @spec todo/keep\n */\nexport function keepList(items) {\n  return items.slice();\n}\n' > src/list.js
printf 'import { test } from "node:test";\ntest("[todo/kept] kept", () => {});\n' > tests/list.test.js
git add -A && git commit -qm init
before=$(date +%s)
rc=0; $V archive alpha > "$T/ar.json" 2> "$T/ar.err" || rc=$?
AD=$(ls -d openspec/changes/archive/*-alpha 2>/dev/null | head -1)
expect "archive records archived_at in the archived folder: ISO 8601 with offset, to the second" '[ -n "$AD" ] && [ -f "$AD/archived.json" ] && node -e "const j=JSON.parse(require(\"fs\").readFileSync(process.argv[1]+\"/archived.json\",\"utf8\"));process.exit(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(j.archived_at)&&Math.abs(Date.parse(j.archived_at)/1000-$before)<120?0:1)" "$AD"'
expect "the answer of archive carries the same time" 'grep -q "\"archived_at\": \"20" "$T/ar.json"'
expect "created_at is recorded when it is known (here: the first commit of the change folder)" 'grep -q "\"created_at\": \"20" "$AD/archived.json"'

echo "== three archives of one day sort by time, not by name"
A="$T/arch"; mkdir -p "$A"
mk() { mkdir -p "$A/$1"; printf '{ "archived_at": "%s" }\n' "$2" > "$A/$1/archived.json"; }
mk 2026-10-28-mango 2026-10-28T09:15:00+02:00
mk 2026-10-28-apple 2026-10-28T16:40:05+02:00
mk 2026-10-28-zebra 2026-10-28T08:00:30+02:00
mk 2026-10-27-late  2026-10-27T23:59:59+02:00
expect "oldest first: zebra 08:00, mango 09:15, apple 16:40 (names would say apple, mango, zebra)" '[ "$(js "console.log(C.archiveOrder(\"$A\").map(x=>x.name.slice(11)).join())")" = "late,zebra,mango,apple" ]'
expect "newest first is the exact reverse" '[ "$(js "console.log(C.archiveOrder(\"$A\",true).map(x=>x.name.slice(11)).join())")" = "apple,mango,zebra,late" ]'
expect "the same time ties by name, the same way every time" '[ "$(js "console.log(C.sortByTime([{n:\"b\",s:{ms:5}},{n:\"a\",s:{ms:5}},{n:\"c\",s:{ms:1}}],x=>x.s,x=>x.n).map(x=>x.n).join())")" = "c,a,b" ]'
expect "an offset is honoured: 08:00+02:00 is before 07:30+00:00" '[ "$(js "console.log(C.sortByTime([{n:\"x\",at:\"2026-10-28T07:30:00+00:00\"},{n:\"y\",at:\"2026-10-28T08:00:00+02:00\"}],o=>({ms:C.parseTime(o.at)}),o=>o.n).map(o=>o.n).join())")" = "y,x" ]'
expect "isoLocal gives offset and seconds; clock shows HH:MM:SS" '[ "$(js "const d=new Date(2026,9,28,14,3,22);console.log(/^2026-10-28T14:03:22[+-]\d\d:\d\d$/.test(C.isoLocal(d))&&C.clock(C.isoLocal(d))===\"14:03:22\"&&C.clock(\"2026-10-28\")===\"\")")" = true ]'

echo "== folders without the file: commit time, then mtime, then the date of the name"
L="$T/legacy"; mkdir -p "$L"; (cd "$L" && git init -q)
for n in 2026-10-20-pear 2026-10-20-fig; do mkdir -p "$L/$n"; echo x > "$L/$n/proposal.md"; done
(cd "$L" && git add 2026-10-20-pear && GIT_COMMITTER_DATE="2026-10-20T08:00:00+02:00" git commit -qm a && git add 2026-10-20-fig && GIT_COMMITTER_DATE="2026-10-20T09:30:00+02:00" git commit -qm b)
mkdir -p "$L/2026-10-20-plum"; echo x > "$L/2026-10-20-plum/proposal.md"; touch -d "2026-10-20 07:00:00" "$L/2026-10-20-plum"
mkdir -p "$L/2026-10-20-with-file"; printf '{ "archived_at": "2026-10-20T08:30:00+02:00" }' > "$L/2026-10-20-with-file/archived.json"
expect "a legacy folder gets the commit time that added it (source git)" '[ "$(js "const s=C.archiveStamp(\"$L\",\"2026-10-20-pear\");console.log(s.source+\" \"+s.ms)")" = "git $(date -d 2026-10-20T08:00:00+02:00 +%s)000" ]'
expect "an untracked legacy folder gets its mtime (source mtime)" '[ "$(js "console.log(C.archiveStamp(\"$L\",\"2026-10-20-plum\").source)")" = mtime ]'
expect "a folder that is gone falls back to the date of its name, at midnight (source name)" '[ "$(js "const s=C.archiveStamp(\"$L\",\"2026-10-20-gone\");console.log(s.source+\" \"+C.when(s))")" = "name 2026-10-20" ] && [ "$(js "console.log(C.archiveStamp(\"$L\",\"no-date-gone\").source)")" = none ]'
expect "mixed: oldest first is pear (git 08:00), with-file (file 08:30), fig (git 09:30); legacy and recorded folders interleave by time" '[ "$(js "console.log(C.archiveOrder(\"$L\").filter(x=>x.stamp.source!==\"mtime\").map(x=>x.name.slice(11)).join())")" = "pear,with-file,fig" ]'
expect "the file wins over git" '[ "$(js "console.log(C.archiveStamp(\"$L\",\"2026-10-20-with-file\").source)")" = file ]'
expect "legacy folders are never rewritten: no archived.json appears" '[ ! -e "$L/2026-10-20-pear/archived.json" ] && [ ! -e "$L/2026-10-20-fig/archived.json" ]'

echo "== created time of a change"
CD="$T/ch"; mkdir -p "$CD/one" "$CD/two"
printf 'schema: wingman-spec\ncreated_at: 2026-10-21T10:00:00+02:00\n' > "$CD/one/.openspec.yaml"
printf 'schema: wingman-spec\ncreated: 2026-10-21\n' > "$CD/two/.openspec.yaml"
expect "created_at in .openspec.yaml wins (source file)" '[ "$(js "const s=C.createdStamp(\"$CD/one\");console.log(s.source+\" \"+s.at)")" = "file 2026-10-21T10:00:00+02:00" ]'
expect "a date-only created: is not a time; the folder birth or mtime gives one" '[ "$(js "console.log([\"birth\",\"mtime\"].includes(C.createdStamp(\"$CD/two\").source))")" = true ]'

echo "== replay of archived deltas and run records"
mkdir -p "$T/r/openspec/specs/todo" "$T/r/openspec/changes/archive"
R="$T/r/openspec/changes/archive"
printf '## Requirements\n\n### Requirement: Keep\nThe system SHALL keep a list.\n' > "$T/r/openspec/specs/todo/spec.md"
mkdir -p "$R/2026-10-28-zeta/specs/todo" "$R/2026-10-28-alpha/specs/todo"
printf '## ADDED Requirements\n\n### Requirement: Extra\nThe system SHALL do more.\n' > "$R/2026-10-28-zeta/specs/todo/spec.md"
printf '## REMOVED Requirements\n\n### Requirement: Extra\n' > "$R/2026-10-28-alpha/specs/todo/spec.md"
printf '{ "archived_at": "2026-10-28T08:00:00+02:00" }' > "$R/2026-10-28-zeta/archived.json"
printf '{ "archived_at": "2026-10-28T09:00:00+02:00" }' > "$R/2026-10-28-alpha/archived.json"
expect "zeta added a requirement at 08:00 and alpha removed it at 09:00: the replay ends with it gone (name order would keep it)" '[ "$(node -e "const T=require(\"$SC/traceability.cjs\");console.log([...T.archivedExpectation(\"$T/r\").keys()].join())")" = "" ]'
printf '{ "archived_at": "2026-10-28T10:00:00+02:00" }' > "$R/2026-10-28-zeta/archived.json"
expect "archive them the other way round: zeta last, so the requirement stays expected" '[ "$(node -e "const T=require(\"$SC/traceability.cjs\");console.log([...T.archivedExpectation(\"$T/r\").keys()].join())")" = "todo/extra" ]'
expect "run ids are UTC stamps: read as times, newest last" '[ "$(js "console.log(C.sortRuns([\"20261028T100000Z\",\"20261027T235959Z\",\"20261028T090000Z\"]).join()+\" \"+C.latestRun([\"20261028T100000Z\",\"20261028T090000Z\"]))")" = "20261027T235959Z,20261028T090000Z,20261028T100000Z 20261028T100000Z" ]'
expect "records sort by their time (offsets honoured), equal times keep their order" '[ "$(js "console.log(C.sortRecords([{at:\"2026-10-28T10:00:00Z\",k:1},{at:\"2026-10-28T11:00:00+02:00\",k:2},{at:\"2026-10-28T09:00:00Z\",k:3},{at:\"2026-10-28T09:00:00Z\",k:4}]).map(r=>r.k).join())")" = "2,3,4,1" ]'
echo
echo "chronology: passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
