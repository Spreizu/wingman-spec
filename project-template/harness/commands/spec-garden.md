---
description: "Realign a wingman-spec project's living specs with its code: take the drift report and fix each gap or accept it."
argument-hint: "[--check]"
---
Spec gardening. Specs and code drift apart: a requirement nobody implemented, code that moved, a test tagged to a renamed scenario, a change archived without sync. `verify-task.cjs drift` finds the gaps. You decide with the user what each one means, then fix the gap or accept it.

{{> openspec-root}}

**Input**: optional `--check` (report only: run step 1, present the table, write nothing). Always announce the OpenSpec root you use.

`V` below is `node <code-repo>/openspec/scripts/verify-task.cjs` (add `--root <root>` or `--store <id>` if the OpenSpec root is not detected). Run it from the code repository.

## Steps

1. **Get the report.** `V drift --text` (or without `--text` for JSON). Gap types:
   - `unanchored-requirement`: a requirement of the living specs with no `@spec` code anchor.
   - `untested-requirement`: no test anchor (no `@spec` marker in a test and no scenario tag).
   - `orphan-anchor`: a marker in code or tests that points at a requirement that does not exist (removed or renamed).
   - `stale-test-tag`: a test tagged `[capability/scenario-slug]` for a scenario that no longer exists.
   - `unsynced-archive`: a requirement of an archived change is missing from `openspec/specs/` (not synced, or removed by hand).
   - `misplaced-marker`: a marker that says nothing about the code where it sits: `trailing-marker`, `duplicate-marker`, `file-top-marker` or `detached-marker`. The `anchor_placement` level sets it: advisory under `warn`, a failing gap under `error`, absent under `off`. The fix is mechanical: move the marker into the function's doc comment or onto its own line above the lines it covers, or delete the duplicate.
   - `over-anchored`: `anchorfit` suspects a marker does not belong. It is a heuristic: read the code before you act. Cases:
     - the marker is on an import, constant, type, string/i18n table, getter or logging line;
     - the marker is in another capability's file, or on code that shares no word with the requirement;
     - one small unit carries many requirements;
     - the requirement has more than `anchor_max` (default 6) anchors and some are weak (named once). Only the weak ones are listed. `Anchors: many` or `anchor_many` skips this case.

     The `anchor_fit` level (default advisory) sets how it is reported. The finding says whether the marker is removable; a requirement's last code anchor never is. Remove it with `V anchors prune --apply [--select file:line,...]`, which edits marker lines only and passes the anchor guard. If it is the requirement's only anchor, move it to the deciding function instead.
   - `stale-anchor`: the code of an anchored unit changed in a later commit than its requirement's text. It means "look again", not "wrong". Level `anchor_stale`: `info` (default), `warn`, `error` or `off`. Ignored: whitespace and comment-only edits, moved code, and commits that also touched the spec. Skipped with a note in a shallow clone or without git.
   If `V drift` reports no open gaps, say so and stop. Accepted gaps are listed as accepted, not as open. A gap that is not accepted is fixed, and it disappears by itself once it is fixed.

2. **Investigate each gap** before judging it. Read the requirement, its scenarios, and the code and tests around it. Use `git log -S` when the history matters. Many gaps are mechanical, such as a typo in a marker; fix those. Only the rest needs a decision.

   For a `stale-anchor`, read the commit (`git show <commit> -- <file>`) against the requirement. Still true: **accept**. The behaviour moved on: **amend the requirement**, or **redo** if the code is wrong.

3. **Decide per gap.** Recommend one outcome with your reason. The user confirms before anything is written.
   - **fix the code or the test (redo)**: the requirement is right; the code or test is missing or wrong. Fix it test-first: add tasks to a new change (`garden-<YYYY-MM-DD>`, or the open change that owns it) and run `/spec-apply`. For a one-line fix use `/spec-fix`. Nothing is recorded; the gap disappears once the anchors exist.
   - **amend the requirement**: the requirement is wrong, obsolete or renamed. Change the living spec through a change `garden-<YYYY-MM-DD>` with MODIFIED/REMOVED/RENAMED deltas, keep the `Why:` lines valid, then `/spec-sync`. Never write `openspec/specs/` by hand. **An amendment that rewrites a requirement's Why or removes a requirement needs the owner's approval**: show the old and new wording, and add the `Owner approval:` line to the proposal only after they agree. Never remove a requirement on your own.
   - **accept**: only for `unanchored-requirement`, `untested-requirement` and `stale-anchor`, when the difference is fine. Examples: legacy code that predates anchors, a requirement implemented elsewhere or intentionally unanchored, a changed unit whose requirement still holds.
   Every other gap is fixed or removed, never accepted:
   - `orphan-anchor`, `stale-test-tag`: retarget or delete the marker or tag.
   - `misplaced-marker`: move or delete it. `over-anchored`: prune or move it.
   - `unsynced-archive`: re-add the requirement, or retire it with a REMOVED delta in a change.
   - `unconfirmed-requirement`: add `Confirmed:` or move it to `observed/`. `observed-incomplete`: complete the entry.

4. **Record an acceptance**: `V drift decide <gap-key> --accept --note "<why, one sentence>"`. The note is required. `V drift` lists the gap keys, e.g. `unanchored-requirement:todo/add-a-todo`.
   - It writes one line, `Accepted: <why>`, on the requirement in `openspec/specs/<capability>/spec.md`, below its `Confirmed:` line and above its first scenario. Nothing else changes, and a repeated call changes nothing. Commit the spec.
   - For a large backlog of one type, e.g. 80 legacy requirements without anchors, confirm with the user first, then run `V drift decide --all unanchored-requirement --accept --note "legacy, anchored when touched"`. It writes the line on each requirement, so parallel branches never conflict.
   - A later change that MODIFIES the requirement drops the line; accept again if the gap is still real.
   - Accepting a `stale-anchor` writes the same line. Once committed, the requirement text is newer than the code until that unit changes again.

5. **Realign and re-check.** For redo and amend gaps, create or extend the garden change with short `/spec-propose` style artifacts; it is a follow-up, not a new product. Run `/spec-apply`, then `/spec-sync` and `V drift` again. Report what is still open.

## Summarize

```
## Garden: <n> gaps
- <gap-key>: accepted (<note>) | fixed in <change> | amended in <change>
Mechanical (marker fixed): <n>
Still open: <n>   Owner approval: <none | requirements>
Next: <the /spec-apply or /spec-sync to run>
```

**Guardrails**
- Never decide for the user: recommend, confirm, then record.
- Never write `openspec/specs/` by hand: change deltas, `V sync` and `V drift decide` do that.
- Never rewrite a requirement's Why or remove a requirement without the owner's approval.
- Do not add markers to make a gap disappear unless the code implements the requirement; an honest accept beats a fake anchor.
