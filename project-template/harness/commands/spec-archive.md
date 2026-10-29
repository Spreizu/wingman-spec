---
description: "Archive a wingman-spec OpenSpec change: always /spec-sync first, then archive through the verifier."
argument-hint: "<change>"
---
Archive a finished change, always after a full sync. It never merges specs itself, it syncs first, every time, and it cannot skip ADR promotion.

{{> openspec-root}}

**Input**: a change name after `/spec-archive` (e.g. `/spec-archive add-auth`). If omitted, infer it from the conversation; if ambiguous, run `openspec list --json` and ask. Always announce: "Using change: <name>".

## Steps

1. **Check the change is still active.** `openspec/changes/<name>/` must exist. If it is already under `openspec/changes/archive/`, say so and stop. If `BLOCKED.md` exists, show it and stop; run `/spec-fix` first.

2. **Check tasks.** Read `tasks.md`. If any `- [ ]` remains, stop and tell the user to finish `/spec-apply` (or `/spec-fix`) first.

3. **Always sync first. This is not optional and not conditional on what you think is already synced.** Run the full `/spec-sync <name>` workflow now (step 1 specs merge, step 2 ADR promotion, step 3 anchor and drift check), inline, even if you believe a sync happened earlier: it is idempotent and costs little when nothing changed. Do not skip it because the user said "just archive". If it reports a problem (an ADR that cannot be promoted, a drift gap that belongs to this change, a rewritten Why or a removed requirement without the owner's approval), stop and report it; do not archive.

4. **Archive through the script.** From the OpenSpec code root run `node openspec/scripts/verify-task.cjs archive <name>` (the code repository root; `--root`/`--store` as in the workspace layout). It re-checks that the change is synced (specs merged, ADRs promoted, anchors resolve, no drift for this change), refuses with exit 1 and the reasons if not, and only then runs `openspec archive "<name>" --skip-specs --yes`. If it refuses, run `/spec-sync <name>` again and fix what it lists; never work around the refusal. Do not run `/opsx:archive` or a bare `openspec archive`: the script is the only way in, because a stock archive skips ADR promotion and the anchors.

5. **Confirm.** The change directory must now be `openspec/changes/archive/YYYY-MM-DD-<name>/` (a name that already starts with a date keeps that prefix). `openspec/changes/<name>/` must be gone.

## Summarize

```
## Archived: <name>
Location: openspec/changes/archive/<dated-name>/
Sync: ran just before archiving (specs merged, ADRs promoted, anchors fresh, drift clean)
Owner approval: <none | the requirements whose Why was rewritten or that were removed, with the approval line>
```

**Guardrails**
- Never write `openspec/specs/` or root `adr/` here. That is `/spec-sync`, which you run first, every time.
- Never archive when the sync check reports a problem, and never bypass `verify-task.cjs archive`.
- Never run `/opsx:archive` or a bare `openspec archive`.
- Do not un-archive or invent a follow-up change here.
