---
description: "Implement a wingman-spec OpenSpec change test-first: one subagent per dispatch (the change when Size S, a task group when M/L), each verified by openspec/scripts/verify-task.cjs."
argument-hint: "<change>"
---
Implement a change test-first. You are the orchestrator: one fresh subagent per dispatch, and a script, not you, decides whether each task is done.

{{> openspec-root}}

**Input**: the change name after `/spec-apply` (e.g. `/spec-apply add-auth`). If omitted, run `openspec list --json` and ask the user to pick.

You are the **orchestrator**. You do not implement tasks yourself (except in the sequential fallback below); you dispatch, run the verifier and stop.

**Steps**

1. **Check readiness.** Run `openspec instructions apply --change "<name>" --json`. If the change is not ready (missing artifacts), tell the user to finish planning with `/spec-propose` and stop.

2. **Run the loop** below until `next` exits `10`, or a stop condition.

{{> apply-loop}}

3. **Finish.** Run `V finish <change>`. It runs without an agent and checks:
   - the full test, typecheck and lint commands;
   - `openspec validate --strict`;
   - every visual scenario of the change;
   - that every scenario has a test tagged `[capability/scenario-slug]`;
   - that no test reads source files as text;
   - with `traceability` on: a Why line, a code anchor and a test anchor for every requirement.

   Exit codes:
   - `0`: passed. If the result lists `why_owner_approval`, the change rewrites the Why of a requirement or removes one. Tell the user which one; the owner must confirm the `Owner approval:` line in proposal.md.
   - `1`: failed. Dispatch ONE `spec-implementer` subagent with the prompt in `fix_prompt` (same dispatch rules as step 2, sequential fallback included), then run `V finish <change>` again.
   - `2`: tasks still open or a config error. Show it and stop.
   - `3`: `BLOCKED.md`. Show it, suggest `/spec-fix`, stop.
   - `4`: the finish attempts are used up. Stop and report the failures.

   Then tell the user: "Run `/spec-archive <name>`; it syncs first (specs, ADRs) and stops if the sync finds a problem." No separate sync step is needed. Include the number of rejected attempts from the run log.

**Per-task discipline** (carried by the `spec-implementer` subagent):
- every implementation task: `test-driven-development`, then `ponytail` (full, YAGNI);
- an unexpected failure, or two failed fixes: `systematic-debugging`;
- review tasks: `requesting-code-review` plus `ponytail-review`;
- before a box is ticked: `verification-before-completion`.

**Guardrails**
- One dispatch per subagent, one subagent at a time.
- Never tick or untick a checkbox yourself, and never edit `tasks.md` to get past the verifier.
- Do not edit specs or ADRs. If they look wrong, stop and tell the user to run `/spec-fix`.
