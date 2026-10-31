---
description: "Archive a finished wingman-spec change: sync its specs and ADRs, then archive through the CLI."
argument-hint: "<change>"
---
Archive a finished change. It always syncs first, so ADR promotion and the spec merge cannot be skipped.

{{> specs-root}}

**Input**: a change name after `/spec-archive` (e.g. `/spec-archive add-auth`). If omitted, infer it from the conversation; if ambiguous, run `.wingman-spec/bin/wingman-spec list` and ask. Always announce: "Using change: <name>".

## Steps

1. **Check the change is active.** `changes/<name>/` must exist in the specs root. If the name is already under `archive/`, say so and stop. If `BLOCKED.md` exists, show it and stop; run `/spec-fix` first.

2. **Check tasks.** If `tasks.md` still has a `- [ ]`, stop and tell the user to finish `/spec-apply` (or `/spec-fix`) first.

3. **Always sync first.** Run the `/spec-sync <name>` steps inline, even when you think nothing changed: the merge is idempotent. If it reports a problem (a merge conflict, an ADR that cannot be promoted, a rewritten Why or a removed requirement without the owner's approval), stop and report it.

4. **Archive.** Run `.wingman-spec/bin/wingman-spec archive <name>`. It re-checks that the change is finished and fully synced, refuses with exit 1 and the reasons if not, and moves the change to `archive/YYYY-MM-DD-HHMM-<name>/` with its timeline. If it refuses, fix what it lists through `/spec-sync`; never move the folder by hand.

5. **Confirm.** `archive/<dated-name>/` exists and `changes/<name>/` is gone. Run `.wingman-spec/bin/wingman-spec drift --text` and mention any gap that belongs to this change.

## Summarize

```
## Archived: <name>
Location: archive/<dated-name>/
Sync: specs merged, ADRs promoted, just before archiving
Owner approval: <none | the requirements whose Why was rewritten or that were removed, with the approval line>
```

**Guardrails**
- Never edit `specs/` or `adrs/` by hand here; `wingman-spec sync` writes them.
- Never archive when the sync reports a problem, and never move a change folder yourself.
- Do not un-archive or invent a follow-up change here.
