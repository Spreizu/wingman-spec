#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# Byte-identical fixers: every auto-fixer and generator that rewrites a file that already exists must leave everything outside
# its own lines byte-identical (human comments, key order, blank lines, quoting, line endings). One case group per fixer: seed human
# edits around the managed part, run the fixer, compare. Helper: tests/lib/byteident.cjs (the original lines must all still be there,
# in order; the fixer may only add lines).
# Usage: tests/fixers.sh (needs node, git, openspec). Exit 0 when every case passes.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export OPENSPEC_TELEMETRY=0 SPEC_INSTALL_PROBE=0 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
unset OPENSPEC_ROOT OPENSPEC_PROJECT_ROOT
PASS=0; FAIL=0; rc=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }
V="node openspec/scripts/verify-task.cjs"
BI="node $PKG/tests/lib/byteident.cjs"
gq() { grep "$@" >/dev/null; }
mk() { rm -rf "$1"; mkdir -p "$1"; ( cd "$1" && git init -q && { openspec init --tools none >/dev/null 2>&1 || mkdir -p openspec/changes openspec/specs; } && "$PKG/install.sh" . --harness all >/dev/null 2>&1 && git add -A && git commit -qm init ); }
inst() { ( cd "$1" && shift && "$PKG/install.sh" "$@" >/dev/null 2>&1 ); }

echo "== adrs --fix (renumbers duplicate ADR numbers)"
A="$T/adr"; mk "$A"; cd "$A" || exit; mkdir -p adr
printf -- '---\r\ntitle: "First"   # keep\r\nstatus: Accepted\r\n---\r\n\r\n\r\nBody with  two  spaces\t and a tab\r\n' > adr/0003-first.md
printf -- "---\ntitle: 'Second'\nstatus: Accepted\nsupersedes: 0001\n---\nBody two\n\n\n" > adr/0003-second.md
printf -- '---\ntitle: One\nstatus: Accepted\n---\nBody one' > adr/0001-one.md
printf '# Our ADR notes\n\nHand-written, no table.\n' > adr/README.md
cp -r adr "$T/adr.before"
expect "adrs --fix renames the later duplicate and keeps every file's bytes" '$V adrs --fix >/dev/null; [ -f adr/0003-first.md ] && [ ! -f adr/0003-second.md ] && n="$(ls adr | grep second)" && cmp adr/$n "$T/adr.before/0003-second.md" && cmp adr/0003-first.md "$T/adr.before/0003-first.md" && cmp adr/0001-one.md "$T/adr.before/0001-one.md" && cmp adr/README.md "$T/adr.before/README.md"'

echo "== drift decide --accept (an Accepted line in openspec/specs/<capability>/spec.md)"
D="$T/drift"; mk "$D"; cd "$D" || exit; mkdir -p openspec/specs/billing openspec/specs/members
# billing: LF, hand-edited (a comment, trailing spaces, a tab, a Confirmed line, a requirement with no scenario, a fenced block with a heading-like line)
printf '## Purpose\nBilling.   \n\n<!-- our note: keep -->\n\n## Requirements\n\n### Requirement: Alpha\nThe system SHALL do alpha.\nConfirmed: owner Mari, 2026-01-01\n\n#### Scenario: A\n- **WHEN** a\t\n- **THEN** b\n\n### Requirement: Beta\nThe system SHALL do beta.\n```\n#### Scenario: not a scenario\n```\n\n#### Scenario: B\n- **WHEN** a\n- **THEN** b\n\n### Requirement: Gamma\nThe system SHALL do gamma.\n' > openspec/specs/billing/spec.md
# members: CRLF, no trailing newline
printf '## Purpose\r\nMembers.\r\n\r\n## Requirements\r\n\r\n### Requirement: Mu\r\nThe system SHALL do mu.\r\n\r\n#### Scenario: M\r\n- **WHEN** a\r\n- **THEN** b\r\n\r\n### Requirement: Nu\r\nThe system SHALL do nu.\r\n\r\n#### Scenario: N\r\n- **WHEN** a\r\n- **THEN** b' > openspec/specs/members/spec.md
git add -A; git commit -qm specs
cp -r openspec/specs "$T/drift.before"
dd() { node openspec/scripts/verify-task.cjs drift decide "$@" >/dev/null 2>&1; }
expect "accepting a gap of billing leaves the members spec byte-identical" 'dd unanchored-requirement:billing/alpha --accept --note "legacy" && cmp openspec/specs/members/spec.md "$T/drift.before/members/spec.md"'
expect "only one line is added to its own spec: after the Confirmed line, before the first scenario; every original line is still there, in order" '$BI "$T/drift.before/billing/spec.md" openspec/specs/billing/spec.md >/dev/null && [ "$(diff "$T/drift.before/billing/spec.md" openspec/specs/billing/spec.md | grep -c "^[<>]")" = 1 ] && grep -B1 -A2 "^Accepted: legacy" openspec/specs/billing/spec.md | head -4 | grep -q "Confirmed: owner Mari"'
expect "a requirement whose body has a fenced heading-like line gets the line after the fence, above the real scenario" 'dd unanchored-requirement:billing/beta --accept --note "b" && awk "/### Requirement: Beta/{f=1} f&&/^Accepted: b/{a=NR} f&&/^#### Scenario: B/{s=NR} END{exit !(a&&s&&a<s)}" openspec/specs/billing/spec.md && [ "$(diff "$T/drift.before/billing/spec.md" openspec/specs/billing/spec.md | grep -c "^>")" = 2 ]'
expect "a requirement without a scenario at the end of the file gets the line right after its last line" 'dd unanchored-requirement:billing/gamma --accept --note "g" && tail -2 openspec/specs/billing/spec.md | head -1 | gq "SHALL do gamma" && tail -1 openspec/specs/billing/spec.md | gq "^Accepted: g$"'
cp openspec/specs/billing/spec.md "$T/b.once"
expect "accepting again with the same reason changes nothing (idempotent)" 'dd unanchored-requirement:billing/alpha --accept --note "legacy" && cmp openspec/specs/billing/spec.md "$T/b.once"'
expect "a new reason replaces only that one line" 'dd unanchored-requirement:billing/alpha --accept --note "changed my mind" && [ "$(diff "$T/b.once" openspec/specs/billing/spec.md | grep -c "^[<>]")" = 2 ] && grep -q "^Accepted: changed my mind" openspec/specs/billing/spec.md'
expect "CRLF: the inserted line ends with CRLF too and every other byte of the file is unchanged (no final newline stays none)" 'dd unanchored-requirement:members/nu --accept --note "n" && node -e "
const fs=require(\"fs\");const a=fs.readFileSync(process.argv[1],\"latin1\");const b=fs.readFileSync(process.argv[2],\"latin1\");
const add=\"Accepted: n\r\n\";const i=b.indexOf(add);
process.exit(i>0&&b.slice(0,i)+b.slice(i+add.length)===a&&!/[^\r]\n/.test(b)?0:1)" "$T/drift.before/members/spec.md" openspec/specs/members/spec.md'
expect "CRLF, requirement with a scenario: the line goes in with CRLF, after the SHALL line" 'dd unanchored-requirement:members/mu --accept --note "m" && node -e "const b=require(\"fs\").readFileSync(process.argv[1],\"latin1\");process.exit(b.includes(\"SHALL do mu.\r\nAccepted: m\r\n\r\n#### Scenario: M\")&&!/[^\r]\n/.test(b)?0:1)" openspec/specs/members/spec.md'

echo "== greenfield approve (front matter of understood.md)"
G="$T/gf"; mk "$G"; cd "$G" || exit
$V greenfield start --by Anna --yes >/dev/null 2>&1
mkdir -p openspec/greenfield
{ printf -- '---\r\n# who approved (kept)\r\napproved_by:\r\ncustom_key: "quoted value"\r\napproved_on:\r\napproved_hash:\r\nowner: Mari   # trailing comment\r\n---\r\n# What we understood\r\n\r\n\r\n'
  for h in "Product in one paragraph" "Users and what they need" "What it must do" "Systems it connects to" "What happens when things fail" "Targets" "Out of scope" "Assumptions we made" "Still open"; do printf '## %s\r\nSome  text.\r\n\r\n' "$h"; done; } > openspec/greenfield/understood.md
cp openspec/greenfield/understood.md "$T/understood.before"
crlf_approvals() { [ "$(grep -c "^approved_.*"$'\r'"$" "$1")" = 3 ]; }
expect "approve understood sets only the three approval lines; comments, quoting, order, body and CRLF stay" '$V greenfield approve understood --by "Client Co" >/dev/null 2>&1; grep -q "^approved_by: Client Co" openspec/greenfield/understood.md && grep -v "^approved_" "$T/understood.before" > "$T/u.a" && grep -v "^approved_" openspec/greenfield/understood.md > "$T/u.b" && cmp "$T/u.a" "$T/u.b" && crlf_approvals openspec/greenfield/understood.md'
{ printf -- '---\napproved_by:   # who signed\nkind: x\n---\n# What we understood\n\n'
  for h in "Product in one paragraph" "Users and what they need" "What it must do" "Systems it connects to" "What happens when things fail" "Targets" "Out of scope" "Assumptions we made" "Still open"; do printf '## %s\nSome  text.\n\n' "$h"; done; } > openspec/greenfield/understood.md
$V greenfield approve understood --by Zed >/dev/null 2>&1
expect "a trailing comment on an approval line is kept; the missing keys are added before the closing ---" '[ "$(sed -n 1,6p openspec/greenfield/understood.md | sed "s/^approved_hash: .*/approved_hash: H/;s/^approved_on: .*/approved_on: D/")" = "$(printf -- "---\napproved_by: Zed   # who signed\nkind: x\napproved_on: D\napproved_hash: H\n---")" ]'

echo "== install: AGENTS.md managed block"
P="$T/agents"; mkdir -p "$P"; printf '# Our rules\r\n\r\nBe kind.\r\n' > "$P/AGENTS.md"
printf 'tail of ours without newline' > "$T/tail.txt"
expect "first install appends the block; the human lines before it are byte-identical" 'cp "$P/AGENTS.md" "$T/ag.0"; inst "$P" . --harness cursor; $BI "$T/ag.0" "$P/AGENTS.md" >/dev/null'
# an older block and human text after it (no trailing newline)
expect "re-install replaces only the lines between the markers (human text before and after: byte-identical)" 'sed -i "s/^\(.*WINGMAN-SPEC:START.*\)$/\1\nOLD BLOCK LINE/" "$P/AGENTS.md"; printf "\r\n## After\r\n\r\nhuman after block" >> "$P/AGENTS.md"; cp "$P/AGENTS.md" "$T/ag.1"; inst "$P" . --harness cursor; strip() { awk "/WINGMAN-SPEC:START/{s=1;next} /WINGMAN-SPEC:END/{s=0;next} !s" "$1"; }; [ "$(strip "$T/ag.1" | sed "/^OLD BLOCK LINE/d" | md5sum)" = "$(strip "$P/AGENTS.md" | md5sum)" ] && ! grep -q "OLD BLOCK LINE" "$P/AGENTS.md" && tail -c 17 "$P/AGENTS.md" | grep -q "human after block"'
expect "the last human line keeps no added newline when nothing else changes" 'cp "$P/AGENTS.md" "$T/ag.2"; inst "$P" . --harness cursor; cmp "$P/AGENTS.md" "$T/ag.2"'

echo "== install: hook files (JSON)"
H="$T/hooks"; mkdir -p "$H/.cursor" "$H/.claude" "$H/.codex"
node -e 'const fs=require("fs");const w=(f,j,i)=>fs.writeFileSync(f,JSON.stringify(j,null,i)+"\n");const H=process.argv[1];
  w(H+"/.cursor/hooks.json",{version:1,hooks:{stop:[{command:"echo mine"}]},zzz:true},4);
  w(H+"/.claude/settings.json",{permissions:{allow:["Bash(ls)"]},hooks:{Stop:["mine"]}},"\t");' "$H"
printf '{"hooks":{}}' > "$H/.codex/hooks.json"
cp "$H/.cursor/hooks.json" "$T/h.cursor"; cp "$H/.claude/settings.json" "$T/h.claude"; cp "$H/.codex/hooks.json" "$T/h.codex"
inst "$H" . --harness all
expect "cursor hooks.json (4-space indent, own key order): original lines kept, only the guard added" 'grep -q spec-guard "$H/.cursor/hooks.json" && $BI "$T/h.cursor" "$H/.cursor/hooks.json" --comma >/dev/null'
expect "claude settings.json (tab indent): original lines kept, only the guard added" 'grep -q spec-guard "$H/.claude/settings.json" && $BI "$T/h.claude" "$H/.claude/settings.json" --comma >/dev/null'
expect "codex hooks.json (compact one-line JSON): not reformatted; either untouched or only extended" 'cmp -s "$T/h.codex" "$H/.codex/hooks.json" || $BI "$T/h.codex" "$H/.codex/hooks.json" --comma --final-eol >/dev/null'
printf '{\n  "hooks": { "stop": [ { "command": "echo mine" } ] }\n}\n' > "$H/.claude/settings.json"; cp "$H/.claude/settings.json" "$T/h.claude2"
expect "a hooks file with hand-aligned inline objects is not reformatted: untouched, with a message" 'rm -f "$T/o.txt"; ( cd "$H" && "$PKG/install.sh" . --harness claude > "$T/o.txt" 2>&1 ); cmp "$H/.claude/settings.json" "$T/h.claude2" && gq "NOT modified" "$T/o.txt"'
printf '{\n  // my note\n  "hooks": {}\n}\n' > "$H/.codex/hooks.json"; cp "$H/.codex/hooks.json" "$T/h.codex2"
expect "a hooks file with comments (not plain JSON) is left untouched" 'inst "$H" . --harness codex; cmp "$H/.codex/hooks.json" "$T/h.codex2"'

echo "== install: .gitignore and CLAUDE.md"
Q="$T/gi"; mkdir -p "$Q"; printf '# mine\r\nnode_modules/\r\n\r\ndist' > "$Q/.gitignore"; printf '# Claude notes\r\nmine' > "$Q/CLAUDE.md"
cp "$Q/.gitignore" "$T/gi.0"; cp "$Q/CLAUDE.md" "$T/cl.0"
inst "$Q" . --harness claude
expect ".gitignore: byte-identical (the installer no longer edits it); openspec/.local/ ignores itself" '$BI "$T/gi.0" "$Q/.gitignore" --final-eol >/dev/null && [ "$(cat "$Q/openspec/.local/.gitignore")" = "*" ]'
expect "CLAUDE.md: human lines byte-identical, one import line appended" '$BI "$T/cl.0" "$Q/CLAUDE.md" --final-eol >/dev/null && grep -qx "@AGENTS.md" "$Q/CLAUDE.md"'
expect "a second install changes neither file" 'cp "$Q/.gitignore" "$T/gi.1"; cp "$Q/CLAUDE.md" "$T/cl.1"; inst "$Q" . --harness claude; cmp "$Q/.gitignore" "$T/gi.1" && cmp "$Q/CLAUDE.md" "$T/cl.1"'

echo "== install: generated harness files are overwritten"
R="$T/gen"; mk "$R"; cd "$R" || exit; mkdir -p .cursor/commands
printf 'my own command\n' > .cursor/commands/mine.md
printf '\n\nmy edit at the end\n' >> .cursor/commands/spec-green-start.md; cp .cursor/commands/mine.md "$T/mine.0"; find . -type f -not -path './.git/*' | sort > "$T/gen.before"
expect "a hand-edited generated file is overwritten (no stray file); a file the installer does not own is untouched" 'inst "$R" . --harness cursor; ! grep -q "my edit at the end" .cursor/commands/spec-green-start.md && cmp .cursor/commands/mine.md "$T/mine.0" && find . -type f -not -path "./.git/*" | sort | diff -q - "$T/gen.before" >/dev/null'

echo "== install: workspace pointer file (--specs) and remote hint"
W="$T/ws"; mkdir -p "$W/code" "$W/sp/openspec"; ( cd "$W/sp" && git init -q && git remote add origin https://example.com/a/sp.git ); printf '{"scripts":{"test":"echo ok"}}\n' > "$W/code/package.json"
inst "$W/code" . --specs "$W/sp" --harness cursor
printf '# my pointer notes\nspecs: ../sp   # where\n\n# keep this comment\nverify: |\n  # my verify note\n  - Lint command: `make lint`\n\nowner:   "Mari"\n' > "$W/code/openspec/workspace.yaml"
cp "$W/code/openspec/workspace.yaml" "$T/wy.0"
expect "re-install adds only missing lines to the pointer file (comments, spacing, quoting, order kept)" 'inst "$W/code" . --specs "$W/sp" --harness cursor; $BI "$T/wy.0" "$W/code/openspec/workspace.yaml" --final-eol >/dev/null && grep -q "specs_remote: https://example.com/a/sp.git" "$W/code/openspec/workspace.yaml" && grep -q "Test command:" "$W/code/openspec/workspace.yaml"'
expect "a pointer file without a final newline keeps its last line" 'printf "specs: ../sp" > "$W/code/openspec/workspace.yaml"; cp "$W/code/openspec/workspace.yaml" "$T/wy.1"; inst "$W/code" . --specs "$W/sp" --harness cursor; $BI "$T/wy.1" "$W/code/openspec/workspace.yaml" --final-eol >/dev/null'

echo "== install: .code-workspace"
F="$T/cw"; mkdir -p "$F/c1" "$F/c2" "$F/sp/openspec"; printf '{"scripts":{"test":"echo ok"}}\n' > "$F/c1/package.json"; cp "$F/c1/package.json" "$F/c2/package.json"
node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({folders:[{path:"other"}],settings:{a:1}},null,4)+"\n")' "$F/x.code-workspace"; cp "$F/x.code-workspace" "$T/cw.0"
expect "a 4-space plain-JSON workspace file only gains folder entries" 'inst "$F/c1" . --specs "$F/sp" --workspace-file "$F/x.code-workspace" --harness cursor; grep -q "c1" "$F/x.code-workspace" && $BI "$T/cw.0" "$F/x.code-workspace" --comma >/dev/null'
printf '{\n  // team workspace\n  "folders": [ { "path": "other" } ]\n}\n' > "$F/y.code-workspace"; cp "$F/y.code-workspace" "$T/cw.1"
expect "a workspace file with comments is left untouched" 'inst "$F/c2" . --specs "$F/sp" --workspace-file "$F/y.code-workspace" --harness cursor; cmp "$F/y.code-workspace" "$T/cw.1"'
printf '{"folders":[{"path":"other"}]}' > "$F/z.code-workspace"; cp "$F/z.code-workspace" "$T/cw.2"
expect "a compact one-line workspace file is not reformatted" 'inst "$F/c2" . --specs "$F/sp" --workspace-file "$F/z.code-workspace" --harness cursor; cmp -s "$F/z.code-workspace" "$T/cw.2" || $BI "$T/cw.2" "$F/z.code-workspace" --comma --final-eol >/dev/null'

echo "== install: openspec/config.yaml"
C="$T/cfg"; mkdir -p "$C/openspec"; printf '# my own note about this file\nschema: spec-driven\n# another human comment\n' > "$C/openspec/config.yaml"; cp "$C/openspec/config.yaml" "$T/cfg.0"
expect "a config that holds a human comment is never rewritten (a suggestion file is written instead)" 'inst "$C" . --harness cursor; cmp "$C/openspec/config.yaml" "$T/cfg.0"'
printf 'schema: wingman-spec\ncontext: |\n  mine   \n\n# trailing\n' > "$C/openspec/config.yaml"; cp "$C/openspec/config.yaml" "$T/cfg.1"
expect "a config that already uses wingman-spec is byte-identical after re-install" 'inst "$C" . --harness cursor; cmp "$C/openspec/config.yaml" "$T/cfg.1"'

echo
echo "fixers: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
