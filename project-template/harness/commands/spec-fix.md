---
description: "Correct post-implementation findings in a wingman-spec OpenSpec change, keeping specs and code in lockstep."
argument-hint: "[change] [findings]"
---
Correct post-implementation findings from manual testing or developer-requested tweaks, keeping specs in lockstep with the code. Classify each finding first; only then edit the change, implement, or bounce to a new proposal.

{{> openspec-root}}

**Input**: `/spec-fix [change] [findings…]`. The first kebab-case token that matches an active or archived change is the change name; the rest is the findings. If the name is omitted, infer it from the conversation; if still ambiguous, run `openspec list --json` and ask. If there are no findings, ask what to fix. Always announce: "Using change: <name>".

This command is the approved path to edit specs after apply. `/spec-apply` and its subagents must not edit specs; they stop and point here.

## Steps

1. **Load context.** Resolve the OpenSpec root. Read `openspec/specs/` for the capabilities in play, the target change at `openspec/changes/<name>/` if it is still active, or the matching folder under `openspec/changes/archive/` if it has been archived, plus `progress.md` and `BLOCKED.md` if they exist. Read the relevant tests and code. If `BLOCKED.md` exists, treat it as input for classification; do not continue an apply loop until classification is done.

   **UI findings** ("looks broken on my phone", "the drawer covers the header"): reproduce them first with `node <code-repo>/openspec/scripts/verify-task.cjs visual <change>` (or `--scenario <id>`). It opens the scenarios and lists DOM, accessibility and runtime defects. With screenshots on, it also saves clip images of the key elements. Name the scenario, state and viewport in the finding. A UI problem that no visual scenario covers is a **spec-mistake** too: add the missing ```` ```visual ```` block (or the missing key element, state or viewport), so the check catches it from now on.

2. **Classify each finding.** Use a short round of the `grilling` skill, not a full `/spec-explore`. For every finding, recommend one class and wait for the user to confirm before writing anything.
   Every finding ends in one of the outcomes `/spec-garden` uses for drift:
   - **redo**: the spec is right; fix the implementation.
   - **amend**: the requirement was wrong; change it.
   - **accept**: the difference is fine; change nothing but record why.
 A `BLOCKED.md` carries a `Proposed outcome: redo|amend|accept|new-work` line written by the implementer; treat it as a proposal to confirm, not a decision. Classes:
   - **code-bug** (outcome **redo**): the spec is right; the implementation or tests do not match. Do **not** edit specs. Append test-first tasks. A UI fix task gets a `Visual:` line naming the scenario: the verifier re-checks it, the visual reviewer compares its before/after images, and `finish` guards every other declared scenario.
   - **spec-mistake** (outcome **amend**): the spec definition was wrong, incomplete, or a developer requested a correction to intended behavior. Update the change's delta spec (`ADDED` / `MODIFIED` / `REMOVED`). If code and tests already match the *corrected* behavior, stop at the spec (then `/spec-sync`). If they followed the wrong spec, update the spec **and** append TDD tasks.
   - **accepted deviation** (outcome **accept**): the code differs from the spec (or a task could not be done as written) and the owner agrees that it stays that way. Change no code and no requirement text; when it matches an unanchored, untested or stale-anchor drift gap (see `verify-task.cjs drift`), record it with `node <code-repo>/openspec/scripts/verify-task.cjs drift decide <gap-key> --accept --note "<why it is fine>"` (one `Accepted:` line on the requirement), otherwise write the reasoning in `progress.md`. If `BLOCKED.md` exists, remove it only when the outcome leaves nothing to do (accept) or after the change is amended/tasks appended.
   - **new-work**: a new capability or a substantial new requirement. Do not implement it here. Classification only: list it in the summary, and tell the user to run `/spec-explore` then `/spec-propose`.

   **Why.** When a correction rewrites the Why of a requirement, or removes a requirement, it needs the owner's approval: show the owner the old and the new text, and add the `Owner approval:` line to the change's proposal only after they agree. A corrected requirement keeps its `Why:` line (a correction that does not touch the Why needs no approval); a new one needs one. When you change the spec, tasks, design or ADRs of a change that is being built, add one `Decision: <what and why>` line to its design.md; the next `next`, `check` or `finish` records it in the change's timeline.

   Present a table: Finding | Class (outcome) | Spec change? | Code change? | Notes.

3. **Choose where the delta lives.**
   - **Active change** (`openspec/changes/<name>/` exists): patch it in place. Rewrite that change's spec files so they describe the corrected contract. Append a `QA fix` group to `tasks.md` (its tasks do not count against the `Size:` cap; merge findings that touch the same file into one task); never uncheck finished work. Touch `proposal.md`, `design.md` or `adrs/` only when the correction actually changes why, how, or a decision.
   - **Archived, or no owning change**: confirm a kebab-case name (default `fix-<original>`), run `openspec new change "<name>"`. Write **short** artifacts in schema order (`app-map` → `proposal` → `specs` → `design` → `adrs` → `tasks`). Keep them short: this is a follow-up, not a new product. A Size S, Risk none change without sensitive paths or UI writes only `proposal`, `specs` and `tasks`. Deltas target the promoted specs in `openspec/specs/`.

   Never write `openspec/specs/` or the root `adr/` directory here. Promotion stays `/spec-sync`.

4. **Validate.** Run `openspec validate "<name>" --strict`. Fix problems only in files this command wrote.

5. **Implement only new work.** If `tasks.md` has unchecked `- [ ]` items this command added, you are the **orchestrator**, exactly as in `/spec-apply`. Earlier tasks are already ticked, so `next` starts at the first new one. When `next` exits 10, run `V finish <change>` as in `/spec-apply` (delete `openspec/.apply-runs/<change>/finish.json` first if an earlier finish ran out of attempts).

{{> apply-loop}}

   If there are no new unchecked tasks (spec-only correction), skip this step.

6. **Summarize.** Keep this table:
   ```
   ## Fixed: <change>
   Findings:
   - <finding>: code-bug (redo) | spec-mistake (amend) | accepted (accept; recorded) | new-work (bounced to /spec-explore)
   Specs:
   - <capability>: updated | unchanged
   Tasks:
   - added <n> | none (spec-only)
   Next: run /spec-apply <name> if tasks were added; when it is ready to close: /spec-archive <name> (it syncs first). /spec-sync <name> only to inspect or fix a sync problem.
Owner approval: <none | requirements>
   ```

**Guardrails**
- Do not guess what the owner wants; ask when classification is unclear.
- Do not invent capabilities. Do not archive.
- Never write directly to `openspec/specs/` or root `adr/`.
- Never tick a checkbox you did not verify.
- Do not silently continue a blocked apply; classify first (redo, amend or accept).
- New-work findings are out of scope: `/spec-explore` then `/spec-propose`.
