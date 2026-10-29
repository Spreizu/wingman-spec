#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# Apply-run state: who owns a run, what a verification record was made from, the lock, and the status lines.
# Usage: tests/apply-runs.sh   (needs openspec and node on PATH). Exit 0 when every case passes.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export SPEC_TRACEABILITY=off OPENSPEC_TELEMETRY=0 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
unset SPEC_SESSION OPENSPEC_ROOT
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }
LJ() { node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).passed[process.argv[2]]||{};process.stdout.write(String(l[process.argv[3]]==null?"":l[process.argv[3]]))' "$1" "$2" "$3"; }
J() { node -e 'let v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const k of process.argv[2].split("."))v=v==null?v:v[k];process.stdout.write(v==null?"":typeof v==="object"?JSON.stringify(v):String(v))' "$1" "$2"; }
V="node openspec/scripts/verify-task.cjs"
C=openspec/changes/demo

cd "$T" && mkdir p && cd p && git init -q -b main
openspec init --tools none >/dev/null 2>&1 || mkdir -p openspec/changes openspec/specs
"$PKG/install.sh" . >/dev/null || { echo "install failed"; exit 1; }
sed -i.b 's/Test command: <fill in>/Test command: none/' openspec/config.yaml && rm -f openspec/config.yaml.b
git add -A && git commit -qm init
mkdir -p $C/specs/demo src tests
printf '## Why\nDemo change for the run-state tests.\n\n## What Changes\n- Adds a demo capability.\n\n## Edge cases\n- none named\n' > $C/proposal.md
printf '## ADDED Requirements\n\n### Requirement: Demo\nThe system SHALL greet.\n\n#### Scenario: greet\n- **WHEN** asked\n- **THEN** it greets\n' > $C/specs/demo/spec.md
printf '## 1. G\n- [ ] 1.1 one\n  - Files: src/a.js\n  - Done when: `true` exits 0\n- [ ] 1.R Review\n  - Files: src/a.js\n  - Done when: `true` exits 0\n' > $C/tasks.md
echo "it('[demo/greet] greets', () => {});" > tests/greet.test.js
echo "exports.greet = () => 'hi';" > src/a.js
git add -A && git commit -qm change
tick() { sed -i "s/- \[ \] $1 /- [x] $1 /" $C/tasks.md; }
resetruns() { rm -rf openspec/.apply-runs; }
runid() { cat openspec/.apply-runs/demo/current 2>/dev/null; }

echo "== a run records who started it and from what"
rc=0; $V next demo --session A > "$T/a.json" 2> "$T/a.err" || rc=$?
R=openspec/.apply-runs/demo/$(runid)
expect "next starts a run owned by session A: run.json has session, worktree, branch, HEAD, start and no tree hash (a new run hashes nothing)" '[ $rc = 0 ] && [ "$(J $R/run.json session)" = A ] && [ "$(J $R/run.json branch)" = main ] && [ "$(J $R/run.json head)" = "$(git rev-parse HEAD)" ] && [ -z "$(J $R/run.json tree)" ] && [ -n "$(J $R/run.json started)" ] && [ "$(J $R/run.json worktree)" = "$(pwd -P)" ]'
expect "the verdict says plainly that this is a new run, with its session and commit" 'J "$T/a.json" run_status | grep -q "^new run .*session A.*main at $(git rev-parse --short=8 HEAD)" && grep -q "verify-task: new run" "$T/a.err"'
expect "the working-tree hash is the hash of the committed tree while nothing is edited" '[ "$(node -e "console.log(require(\"./openspec/scripts/runstate.cjs\").fingerprint(\".\").tree)")" = "$(git rev-parse HEAD^{tree})" ]'

echo "== a second session on the same change is refused, with the way to take over"
cp $R/state.json "$T/state.before"
rc=0; $V next demo --session B > "$T/b.json" 2> "$T/b.err" || rc=$?
expect "session B: exit 2, result run-owned, names session A, its start and --takeover" '[ $rc = 2 ] && [ "$(J "$T/b.json" result)" = run-owned ] && grep -q "belongs to session A" "$T/b.err" && grep -q -- "--takeover" "$T/b.err" && grep -q "your session B" "$T/b.err"'
expect "the refusal changed nothing: same run, same task state" '[ "$(runid)" = "$(basename $R)" ] && cmp -s $R/state.json "$T/state.before"'
rc=0; $V check demo --session B --reported done > "$T/b2.json" 2> "$T/b2.err" || rc=$?
expect "session B cannot check session As task either (it would revert As tick)" '[ $rc = 2 ] && [ "$(J "$T/b2.json" result)" = run-owned ]'
rc=0; $V next demo --session A > "$T/a2.json" 2> /dev/null || rc=$?
expect "session A continues its own run: same run id, status says own" '[ $rc = 0 ] && [ "$(J "$T/a2.json" run)" = "$(pwd -P)/$R" ] && J "$T/a2.json" run_status | grep -q "^own run"'
rc=0; $V next demo --session B --takeover > "$T/b3.json" 2> "$T/b3.err" || rc=$?
expect "--takeover adopts the run: exit 0, status says took over, the takeover is in metrics.jsonl, same task and attempt" '[ $rc = 0 ] && J "$T/b3.json" run_status | grep -q "^took over" && grep -q "\"event\":\"takeover\"" $R/metrics.jsonl && [ "$(J $R/run.json session)" = B ] && [ "$(J "$T/b3.json" task.label)" = 1.1 ]'
rc=0; $V check demo --session A --reported done > "$T/a3.json" 2> /dev/null || rc=$?
expect "after the takeover session A is the one refused" '[ $rc = 2 ] && [ "$(J "$T/a3.json" result)" = run-owned ]'
node -e 'const f=process.argv[1];const r=JSON.parse(require("fs").readFileSync(f,"utf8"));r.last_activity=new Date(Date.now()-45*60000).toISOString();require("fs").writeFileSync(f,JSON.stringify(r))' $R/run.json
rc=0; $V next demo --session A > "$T/a4.json" 2> /dev/null || rc=$?
expect "a run idle for 45 minutes is adopted without --takeover, and the status says why" '[ $rc = 0 ] && J "$T/a4.json" run_status | grep -q "took over.*idle 45 min"'
rc=0; $V next demo --session "bad id" > "$T/s.json" 2> "$T/s.err" || rc=$?
expect "an unusable --session value is rejected" '[ $rc = 2 ] && grep -q -- "--session needs" "$T/s.err"'
resetruns; $V next demo > /dev/null 2>&1
rc=0; $V next demo > "$T/u.json" 2> /dev/null || rc=$?
expect "without any session id nothing can be refused: the run is resumed and the status says the owner is unknown" '[ $rc = 0 ] && J "$T/u.json" run_status | grep -q "session of this run is unknown"'
rc=0; SPEC_SESSION=envsess $V next demo > "$T/u2.json" 2> /dev/null || rc=$?
expect "SPEC_SESSION works like --session (a run with an unknown owner is not refused)" '[ $rc = 0 ]'

echo "== one live command per change (lock)"
resetruns; $V next demo --session A > /dev/null 2>&1
printf -- '- [x] 1.1 one\n' > /dev/null
sed -i 's/- \[ \]/- [x]/' $C/tasks.md
( $V finish demo --session A --test-cmd 'sleep 5' > "$T/f1.json" 2> /dev/null ) &
FPID=$!; sleep 1.5
rc=0; $V next demo --session A > "$T/busy.json" 2> "$T/busy.err" || rc=$?
expect "a command that starts while finish is running is refused: result busy, names the running command and pid" '[ $rc = 2 ] && [ "$(J "$T/busy.json" result)" = busy ] && grep -q "\`finish\`" "$T/busy.err" && grep -q "pid " "$T/busy.err"'
wait $FPID
expect "the lock is gone when the command ends" '[ ! -e openspec/.apply-runs/demo/lock.json ]'
rc=0; $V status demo > "$T/st.json" 2>/dev/null || rc=$?
expect "status needs no lock and still answers while nothing runs" '[ $rc = 0 ] && [ -n "$(J "$T/st.json" run_status)" ]'
printf '{"pid":%s,"host":"%s","session":"Z","command":"check","started":"2026-01-01T00:00:00Z","heartbeat":"%s"}\n' "$$" "$(hostname)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > openspec/.apply-runs/demo/lock.json
rc=0; $V next demo --session A > "$T/l2.json" 2> /dev/null || rc=$?
expect "a lock held by a live process with a fresh heartbeat refuses" '[ $rc = 2 ] && [ "$(J "$T/l2.json" result)" = busy ]'
rc=0; $V next demo --session A --takeover > "$T/l3.json" 2> /dev/null || rc=$?
expect "--takeover replaces the lock" '[ $rc != 2 ] || [ "$(J "$T/l3.json" result)" != busy ]'
printf '{"pid":999999,"host":"%s","session":"Z","command":"check","started":"2026-01-01T00:00:00Z","heartbeat":"%s"}\n' "$(hostname)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > openspec/.apply-runs/demo/lock.json
rc=0; $V next demo --session A > "$T/l4.json" 2> /dev/null || rc=$?
expect "a lock whose process is dead is ignored" '[ "$(J "$T/l4.json" result)" != busy ]'
printf '{"pid":%s,"host":"%s","session":"Z","command":"check","started":"2026-01-01T00:00:00Z","heartbeat":"2026-01-01T00:00:00Z"}\n' "$$" "$(hostname)" > openspec/.apply-runs/demo/lock.json
rc=0; $V next demo --session A > "$T/l5.json" 2> /dev/null || rc=$?
expect "a lock with an old heartbeat is ignored even when the pid is alive (pid reuse)" '[ "$(J "$T/l5.json" result)" != busy ]'

echo "== a verification record carries the commit and the task files; another branchs record does not count"
git checkout -q -- . ; resetruns
$V next demo --session A > /dev/null 2>&1; tick 1.1; rc=0; $V check demo --session A --reported done > "$T/c1.json" 2>/dev/null || rc=$?
expect "check passes task 1.1" '[ $rc = 0 ]'
L=openspec/.apply-runs/demo/verified.json
expect "the ledger entry has run, session, HEAD, branch, worktree, tree hash and the hash of the task Files:" '[ "$(LJ $L "1.1 one" head)" = "$(git rev-parse HEAD)" ] && [ "$(LJ $L "1.1 one" branch)" = main ] && [ "$(LJ $L "1.1 one" session)" = A ] && [ -n "$(LJ $L "1.1 one" tree)" ] && [ -n "$(LJ $L "1.1 one" files_hash)" ] && [ "$(LJ $L "1.1 one" worktree)" = "$(pwd -P)" ]'
rc=0; $V next demo --session A > "$T/rv.json" 2> /dev/null || rc=$?
expect "the review task's packet carries BASE_SHA (the commit the run started from) and HEAD_SHA (a snapshot of the working tree), and the task before it does not" '[ $rc = 0 ] && [ "$(J "$T/rv.json" task.label)" = 1.R ] && [ "$(J "$T/rv.json" review_range.base)" = "$(cat openspec/.apply-runs/demo/base)" ] && [ -n "$(J "$T/rv.json" review_range.head)" ] && [ -z "$(J "$T/c1.json" review_range)" ]'
$V next demo --session A --format prompt 2> /dev/null > "$T/rv.txt"
expect "the review prompt gives both SHAs and forbids deriving them with git" 'grep -q "BASE_SHA=$(J "$T/rv.json" review_range.base) HEAD_SHA=$(J "$T/rv.json" review_range.head)" "$T/rv.txt" && grep -q "do not run git rev-parse" "$T/rv.txt"'
tick 1.R; $V check demo --session A --reported done > /dev/null 2>&1
rc=0; $V next demo --session A > "$T/cm.json" 2> /dev/null || rc=$?
expect "next with everything verified says so in one line: tasks, last check, run, commit, and that the working tree is unchanged" '[ $rc = 10 ] && J "$T/cm.json" status | grep -q "2 of 2 tasks are ticked and verified" && J "$T/cm.json" status | grep -q "by run" && J "$T/cm.json" status | grep -q "unchanged since" && J "$T/cm.json" status | grep -q "finish has not passed yet"'
echo "-- nothing is committed during the change: records and finish hold on a dirty tree"
expect "the working tree is dirty (ticks and code are uncommitted) when finish runs" '[ -n "$(git status --porcelain)" ]'
rc=0; $V finish demo --session A > "$T/fin0.json" 2> /dev/null || rc=$?
expect "finish passes on the uncommitted tree and says the result holds" '[ $rc = 0 ] && J "$T/fin0.json" status | grep -q "still holds"'
rc=0; $V next demo --session A > "$T/cm0.json" 2> /dev/null || rc=$?
expect "next on the uncommitted tree: all verified, no record is foreign, the finish is valid" '[ $rc = 10 ] && J "$T/cm0.json" status | grep -q "that result still holds"'
git add -A; git commit -qm done
rc=0; $V next demo --session A > "$T/cm1.json" 2> /dev/null || rc=$?
expect "the user committing afterwards (same tree) does not make the finish stale" '[ $rc = 10 ] && J "$T/cm1.json" status | grep -q "that result still holds"'
rc=0; $V finish demo --session A > "$T/fin.json" 2> /dev/null || rc=$?
expect "finish passes and its status names the run, the commit and that the result still holds" '[ $rc = 0 ] && J "$T/fin.json" status | grep -q "finish passed" && J "$T/fin.json" status | grep -q "still holds"'
rc=0; $V next demo --session A > "$T/cm2.json" 2> /dev/null || rc=$?
expect "after finish, next reports the finish as valid" '[ $rc = 10 ] && J "$T/cm2.json" status | grep -q "that result still holds"'
echo "// edited after finish" >> src/a.js
rc=0; $V next demo --session A > "$T/cm3.json" 2> /dev/null || rc=$?
expect "code changed after finish: the status says STALE and to run finish again (ticks still drive next)" '[ $rc = 10 ] && J "$T/cm3.json" status | grep -q "STALE" && J "$T/cm3.json" status | grep -q "different from that check"'
rc=0; $V finish demo --session A > "$T/fin2.json" 2> "$T/fin2.err" || rc=$?
expect "a second finish says an earlier finish exists and that it checks everything again" '[ $rc = 0 ] && J "$T/fin2.json" previous_finish | grep -q "an earlier finish" && grep -q "an earlier finish" "$T/fin2.err"'
git checkout -q -- src/a.js

echo "-- the record came from another branch"
git checkout -q -b other HEAD~2
git checkout -q main -- openspec/changes tests
mkdir -p src; echo "exports.greet = () => 'other branch';" > src/a.js
git add -A; git commit -qm "same change, written independently on another branch"
rc=0; $V next demo --session A > "$T/fo.json" 2> "$T/fo.err" || rc=$?
expect "ticks on a branch where no check ran are not verified by the ledger of another branch: unverified-ticks, with the commit and branch the record came from" '[ $rc = 2 ] && [ "$(J "$T/fo.json" result)" = unverified-ticks ] && J "$T/fo.json" foreign | grep -q "not part of this checkout" && J "$T/fo.json" foreign | grep -q "main"'
git checkout -q -f main; git branch -qD other
expect "back on the branch of the record, nothing is foreign" '[ "$($V next demo --session A 2>/dev/null | node -e "process.stdout.write(JSON.parse(require(\"fs\").readFileSync(0,\"utf8\")).result)")" = complete ]'
git checkout -q -b amended
git commit -q --amend -m "done (amended)" --allow-empty
rc=0; $V next demo --session A > "$T/am.json" 2> /dev/null || rc=$?
expect "a rewritten commit with the same files keeps the records valid (same tree)" '[ $rc = 10 ]'
git checkout -q main; git branch -qD amended

echo "== worktrees keep their own runs"
sed -i 's/- \[x\] /- [ ] /' $C/tasks.md; git add -A; git commit -qm "tasks reopened"
resetruns; $V next demo --session A > /dev/null 2>&1
git worktree add -q "$T/wt" -b wtb HEAD
( cd "$T/wt" && rc=0; $V next demo --session B > "$T/w.json" 2> /dev/null || rc=$?; echo $rc > "$T/w.rc" )
expect "a git worktree has its own run: session B starts one there without touching As" '[ "$(cat $T/w.rc)" = 0 ] && [ "$(J "$T/w.json" run)" != "$(pwd -P)/openspec/.apply-runs/demo/$(runid)" ] && [ -d "$T/wt/openspec/.apply-runs/demo" ]'

echo "== split layout: the specs repo is shared by every code worktree"
resetruns
export OPENSPEC_ROOT="$(pwd -P)"
$V next demo --session A > /dev/null 2>&1
( cd "$T/wt" && rc=0; $V next demo --session A > "$T/sp.json" 2> "$T/sp.err" || rc=$?; echo $rc > "$T/sp.rc" )
expect "the same session in another code worktree is refused: the run belongs to the other worktree" '[ "$(cat $T/sp.rc)" = 2 ] && [ "$(J "$T/sp.json" result)" = run-owned ] && grep -q "belongs to the worktree" "$T/sp.err" && grep -q -- "--takeover" "$T/sp.err"'
( cd "$T/wt" && rc=0; $V next demo --session A --takeover > "$T/sp2.json" 2> /dev/null || rc=$?; echo $rc > "$T/sp.rc" )
expect "--takeover adopts it for the other worktree" '[ "$(cat $T/sp.rc)" = 0 ] && J "$T/sp2.json" run_status | grep -q "^took over"'
unset OPENSPEC_ROOT
git worktree remove --force "$T/wt"

echo "== status"
resetruns; $V next demo --session A > /dev/null 2>&1
$V status demo --session A > "$T/ss.json" 2>/dev/null
expect "status names the run, its owner and the last finish" 'J "$T/ss.json" run_status | grep -q "session A" && J "$T/ss.json" run_status | grep -q "yours" && [ -n "$(J "$T/ss.json" last_finish)" ]'
$V status demo --session B > "$T/ss2.json" 2>/dev/null
expect "status of another session says the run is not yours" 'J "$T/ss2.json" run_status | grep -q "NOT yours"'

echo "== the review range of an uncommitted change (no commit is ever created)"
R2="$T/rr"; mkdir "$R2" && cd "$R2" && git init -q -b main && mkdir -p src openspec/.apply-runs/x && printf 'a\n' > src/a.js && printf 'b\n' > src/b.js && printf 'ignored.log\nopenspec/.apply-runs/\n' > .gitignore && git add -A && git commit -qm base
BASE=$(git rev-parse HEAD)
printf 'a2\n' >> src/a.js; printf 'b2\n' >> src/b.js; git add src/b.js; printf 'new\n' > src/new.js; printf 'x\n' > ignored.log; printf 'x\n' > openspec/.apply-runs/x/state.json
snap() { { git log --oneline --all | wc -l; git rev-parse HEAD; git status --porcelain; git diff --cached; git stash list | wc -l; git for-each-ref | wc -l; git branch | wc -l; cksum .git/index; } 2>&1 | cksum; }
BEFORE=$(snap)
RANGE=$(node -e 'const R=require(process.argv[1]+"/openspec/scripts/runstate.cjs");process.stdout.write(JSON.stringify(R.reviewRange(process.cwd(),process.argv[2])))' "$PKG/project-template" "$BASE")
SB=$(node -pe 'JSON.parse(process.argv[1]).base' "$RANGE"); SH=$(node -pe 'JSON.parse(process.argv[1]).head' "$RANGE")
expect "BASE_SHA is the given commit and HEAD_SHA is a different commit whose parent is BASE_SHA" '[ "$SB" = "$BASE" ] && [ -n "$SH" ] && [ "$SH" != "$BASE" ] && [ "$(git rev-parse $SH^)" = "$BASE" ]'
expect "git diff BASE_SHA HEAD_SHA shows the unstaged edit, the staged edit and the untracked file, and neither the ignored file nor the run log" '[ "$(git diff --name-only $SB $SH | sort | tr "\n" " ")" = "src/a.js src/b.js src/new.js " ]'
expect "nothing changed in the repository: log, HEAD, status, index, staged diff, stash, refs and branches are as before" '[ "$(snap)" = "$BEFORE" ] && [ "$(git log --oneline | wc -l)" = 1 ]'
git add -A; git commit -qm user
expect "after the user commits, the snapshot and its base are still valid and the diff is the same" '[ "$(git diff --name-only $SB $SH | wc -l)" = 3 ] && git cat-file -e $SB'
RANGE2=$(node -e 'const R=require(process.argv[1]+"/openspec/scripts/runstate.cjs");process.stdout.write(JSON.stringify(R.reviewRange(process.cwd(),"0000000000000000000000000000000000000000")))' "$PKG/project-template")
expect "an unknown base falls back to HEAD" '[ "$(node -pe "JSON.parse(process.argv[1]).base" "$RANGE2")" = "$(git rev-parse HEAD)" ]'
cd "$T/p"

echo
echo "apply-runs: passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
