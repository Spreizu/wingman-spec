---
description: "Inspect or fix a wingman-spec merge: wingman-spec sync --check, and sync --rebase after the living specs moved."
argument-hint: "<change> [--check]"
---
`/spec-archive` merges the specs and ADRs itself. Run `/spec-sync` only to inspect the merge (`--check`) or to fix a merge the archive refused.

{{> specs-root}}

**Input**: a change name after `/spec-sync` (e.g. `/spec-sync add-auth`), plus optional `--check`. If omitted, infer it from the conversation; if ambiguous, run `.wingman-spec/bin/wingman-spec list` and ask. Always announce: "Using change: <name>".

## Steps

1. **Check.** Run `.wingman-spec/bin/wingman-spec sync <change> --check`. It writes nothing and lists, by file and line, what would not merge. With `--check`, report it and stop.

2. **Fix what it reports** in the change's delta or ADR, never in `specs/` or `adrs/`:
   - `base changed`, or a capability created or deleted "after this change was planned": the living spec moved since the plan. Read the new living text and update the delta to it. Then run `.wingman-spec/bin/wingman-spec sync <change> --rebase` to pin it.
   - Any other refusal names the rule (`wingman-spec help reference`, "Merge refusals"): fix the delta, through `/spec-fix` if the plan is wrong.
   - Two ADRs with one number after parallel branches: `.wingman-spec/bin/wingman-spec adrs --fix`.

3. **Recheck** with step 1 until it is clean, then tell the user: "Run `/spec-archive <change>`."

**Guardrails**
- Never edit `specs/` or `adrs/` by hand, never renumber a promoted ADR, and never write a table in `adrs/README.md`.
- Do not archive here.
