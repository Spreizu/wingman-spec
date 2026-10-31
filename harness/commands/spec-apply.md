---
description: "Implement a wingman-spec change test-first: one subagent per dispatch (the change when Size S, a task group when M/L, parallel waves for independent tasks), each verified by wingman-spec check."
argument-hint: "<change>"
---
Implement a change test-first. You are the orchestrator: one fresh subagent per dispatch, and the CLI, not you, decides whether each task is done.

{{> specs-root}}

**Input**: the change name after `/spec-apply` (e.g. `/spec-apply add-auth`). If omitted, run `.wingman-spec/bin/wingman-spec list` and ask the user to pick.

You do not implement tasks yourself (except when no subagent can run); you dispatch, run the CLI and stop.

**Steps**

1. **Check readiness.** Run `.wingman-spec/bin/wingman-spec status <change>`. If an artifact is missing, tell the user to finish planning with `/spec-propose` and stop.

2. **Run the loop** below until `next` exits `10`, then finish, or until a stop condition.

{{> apply-loop}}

3. **After finish.**
   - `0`: passed. If the result lists `why_owner_approval`, the change rewrites the Why of a requirement or removes one: name it to the user; the owner must confirm the `Owner approval:` line in proposal.md. Then run `wingman-spec log <change> approval "<what was approved>"`.
   - `2`: tasks still open or a config error. Show it and stop.
   - `3`: `BLOCKED.md`. Show it, suggest `/spec-fix`, stop.
   - `4`: the finish attempts are used up. Stop and report the failures.

   Then tell the user: "Run `/spec-archive <change>`; it syncs the specs and ADRs and stops on a problem." Include the number of rejected attempts from the run's timeline.

**Per-task discipline** (carried by the `spec-implementer` subagent):
- every implementation task: `test-driven-development`, then `ponytail` (full, YAGNI);
- an unexpected failure, or two failed fixes: `systematic-debugging`;
- review tasks: `requesting-code-review` plus `ponytail-review`;
- before a box is ticked: `verification-before-completion`.

**Guardrails**
- One prompt per subagent; several subagents at once only for the packets of one wave.
- Never tick or untick a checkbox yourself, and never edit `tasks.md` to get past the CLI.
- Do not edit specs or ADRs. If they look wrong, stop and tell the user to run `/spec-fix`.
