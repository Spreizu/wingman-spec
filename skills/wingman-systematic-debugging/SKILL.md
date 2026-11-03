---
name: wingman-systematic-debugging
description: >
  Loaded by spec-implementer when a check fails unexpectedly or a fix fails twice.
  Find the root cause before changing more code.
license: MIT
---
# Systematic debugging

Symptom fixes fail `check` again. Find the cause, then change one thing.

## Loop

1. Read the failure: command, exit code, tail, and the files `check` names.
2. Form one hypothesis you can disprove (a value, a branch, a missing call).
3. Prove it with a failing test or a single targeted run. Do not guess-and-patch.
4. Fix the cause. Run the same command that failed.
5. If the fix fails twice, stop. Write what you ruled out to the attempt note and `STATUS: failed`. A fresh subagent gets the failure.

## Stop

- After three failed fixes on the same fault, do not try a fourth. Report.
- Do not edit `tasks.md`, specs or ADRs to make the failure go away.
- Deep traces (when the fault crosses packages): `references/root-cause-tracing.md`.
