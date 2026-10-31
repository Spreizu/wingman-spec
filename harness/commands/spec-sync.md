---
description: "Sync a wingman-spec change: merge its delta specs and promote its ADRs (wingman-spec sync), then check anchors and drift."
argument-hint: "<change> [--check]"
---
Sync a change: merge its delta specs into `specs/`, promote its ADRs to `adrs/`, and check anchors and drift. `/spec-archive` runs these steps itself, so run `/spec-sync` on its own only to inspect (`--check`) or to fix a sync problem.

{{> specs-root}}

The merge and the promotion are done by the CLI, deterministically and idempotently: a second run changes nothing. Never merge a delta or copy an ADR by hand.

**Input**: a change name after `/spec-sync` (e.g. `/spec-sync add-auth`), plus optional `--check`: report only, write nothing. If the name is omitted, infer it from the conversation; if ambiguous, run `.wingman-spec/bin/wingman-spec list` and ask. Always announce: "Using change: <name>".

## Steps

1. **Owner approval.** Run `.wingman-spec/bin/wingman-spec lint <change>`. If it lists `why_owner_approval` (a rewritten Why, or a removed requirement) and the proposal has no `Owner approval:` line, stop and ask the owner. Never write that line yourself. This must happen before the merge: afterwards the old Why is gone.

2. **Check** (always, and the only step with `--check`): `.wingman-spec/bin/wingman-spec sync <change> --check`. It writes nothing and lists what is not merged, which ADRs are not promoted or out of date, and, with traceability on, anchor and drift problems. With `--check`, report it and stop.

3. **Sync**: `.wingman-spec/bin/wingman-spec sync <change>`. It applies the delta sections in a fixed order (RENAMED, REMOVED, MODIFIED, ADDED), copies a new capability's `## Purpose`, and promotes each ADR in `changes/<change>/adrs/` to `adrs/NNNN-<slug>.md` (`status: none` records are skipped; `supersedes:` marks the older ADR). It refuses with exit 1 and writes nothing when the delta conflicts with the living spec (MODIFIED or REMOVED of a missing requirement, ADDED of an existing one, a duplicate name) or an ADR is still a template. Each problem names the file and line: fix the delta or the ADR in the change (through `/spec-fix` if the plan is wrong) and run it again.

4. **Recheck**: run step 2 again. Gaps that are not about this change are drift: decide them with `/spec-garden`, do not paper over them. Two parallel branches can give two ADRs the same number: `.wingman-spec/bin/wingman-spec adrs --fix` renumbers the later one.

## Summarize

```
## Synced: <change>
Specs:
- <capability>: added/modified/removed/renamed requirements ...
ADRs:
- <slug>: promoted as adrs/0004-<slug>.md | updated | unchanged | skipped (none)
Anchors and drift: <clean | problems, see /spec-garden>
```
The change stays active; archive it with `/spec-archive <change>` when implementation is complete.

**Guardrails**
- Never edit the change's own `adrs/` files to get past the sync; fix them only when the sync names them.
- Never edit `specs/` or `adrs/` by hand, never renumber a promoted ADR, and never write a table in `adrs/README.md`.
- Do not archive here.
