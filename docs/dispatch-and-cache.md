# Dispatch scope, result cache and review rule

Why `verify-task.cjs` hands out work the way it does. The commands only say what to do.

## One dispatch, one scope

`next` picks the scope from the plan's `Size:` line:

| Size | One dispatch holds |
| --- | --- |
| S | the whole change (every implementation task, in order) |
| M, L | one task group (the tasks under one `## N.` heading) |
| any | a review task alone; a plan with no `Size:` line, or `--per-task`, gives one task |

`check` then runs once for the dispatch: the `Done when:` command of every member, the project checks once, the visual check once for the union of the members' areas. The verifier ticks every member on a pass and rejects the whole batch when one member fails. A small change costs one implementer start instead of one per task; the scenario tags, `Done when:` tests, source-text rule and `finish` are unchanged. A review task stays its own dispatch so the reviewer does not read the implementer's context.

## Review task

A final review task is expected for Size M/L, a Risk kind, or UI. Fast changes carry none (a leftover one is a warning, a missing one on the full path is a warning too).

## Result cache

`check` and `finish` run the project's tests, typecheck and lint. A passing result is stored under `openspec/.apply-runs/<change>/cache/`, keyed on the git tree of the work (run state and the plan's ticks excluded), the working directory and the command. The same tree and command is not run twice: `finish` reuses what `check` just proved. Any edit, new untracked file or changed command changes the key; a failing result is never stored; `--no-cache` or `SPEC_NO_CACHE=1` turns it off. `Done when:` commands, `validate` and the visual check are never cached (the visual check compares against a capture taken before the task and starts a server). The independent steps of `finish` run in parallel.

## Ask only what the repo cannot answer

`/spec-explore` and `/spec-propose` read the repo first and ask the user only about what the code, the specs and the config cannot answer; every question left is a decision, not a lookup.

## One statement per rule

Placement rules and accessible-name rules live in the implementer agent (and the verifier enforces them); the AGENTS block, the commands and the schema point to it instead of repeating it.
