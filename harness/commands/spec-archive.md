---
description: "Archive a finished wingman-spec change through the CLI: it gates, merges the specs and ADRs, then archives."
argument-hint: "<change>"
---
Archive a finished change with one command; the CLI checks that it is done, merges it and moves it.

{{> specs-root}}

**Input**: a change name after `/spec-archive` (e.g. `/spec-archive add-auth`). If omitted, infer it from the conversation; if ambiguous, run `.wingman-spec/bin/wingman-spec list` and ask. Always announce: "Using change: <name>".

## Steps

1. **Owner approval.** Run `.wingman-spec/bin/wingman-spec lint <name>`. If it lists `why_owner_approval` and the proposal has no `Owner approval:` line, stop and ask the owner. Never write that line yourself.

2. **Archive.** Run `.wingman-spec/bin/wingman-spec archive <name>`. It refuses with exit 1, writes nothing and lists every failed check (`blocked`, `tasks`, `findings`, `finish`, `lint`, `merge`). Fix what it reports and run it again. An open task goes through `/spec-apply`, a stale finish through `wingman-spec finish <name>`, a merge conflict through `/spec-sync <name>`. Never move the folder by hand.

3. **Confirm.** Run `.wingman-spec/bin/wingman-spec drift --text` and mention any gap that belongs to this change.

## Summarize

```
## Archived: <name>
Location: <dir from the output>
Merged: <the specs and ADRs from the output>
Owner approval: <none | the requirements whose Why was rewritten or that were removed, with the approval line>
```

**Guardrails**
- Never edit `specs/` or `adrs/` by hand; the archive writes them.
- Do not un-archive or invent a follow-up change here.
