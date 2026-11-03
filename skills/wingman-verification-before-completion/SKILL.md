---
name: wingman-verification-before-completion
description: >
  Loaded by spec-implementer before STATUS: done. Read the real command output.
  The CLI still re-runs every check; this stops false claims in the reply.
license: MIT
---
# Verification before completion

Do not write `STATUS: done` until you have run the task's `Done when:` command and read its output in this turn.

1. Identify the command that would prove the claim (Done when, tests, typecheck, lint, `wingman-spec visual`).
2. Run it. Read the full tail and the exit code.
3. If it failed, say so (`STATUS: failed`) with that output. Do not claim a pass you did not see.
4. The orchestrator then runs `wingman-spec check`. Its result is the one that ticks the task.
