# What runs when, and what each default costs

`check` and `finish` run the project's own commands (tests, typecheck, lint, a task's `Done when:`) and the CLI's own
scans. `WINGMAN_SPEC_PROFILE=1` (or `--timing`) prints what each command and scan cost, most expensive first, and records
it in the run's `metrics.jsonl` (`event: profile`). A command running for 3 s is announced on stderr, then every 15 s;
`--timeout SEC` or `WINGMAN_SPEC_TIMEOUT_<TESTS|TYPECHECK|LINT|DONE_WHEN|VALIDATE>` limits one command.

## One dispatch, one scope

`next` hands out the whole change at Size S, one task group (the tasks under one `## N.` heading) at M and L, and a
review task alone, so the reviewer does not read the implementer's context. `--per-task`, or a plan without a `Size:`
line, gives one task. `check` runs once per dispatch and ticks every member on a pass, or rejects the whole dispatch.

## Result cache

A passing result of the tests, typecheck or lint is stored under `runs/<change>/cache/`, keyed on the git tree of the
work (run state and the plan's ticks left out), the working directory and the command. `finish` reuses what `check`
just proved. Any edit, new untracked file or changed command changes the key; a failing result is never stored;
`--no-cache` or `WINGMAN_SPEC_NO_CACHE=1` turns it off. `Done when:` commands, `validate` and the visual check are never
cached.

## What runs when

- At every `check`: the `Done when:` of each task of the dispatch and the static scans (traceability, anchors, size, plan lint).
- At every `check` (default `check_level: targeted`): the task's targeted tests only. These are the test files the change added or edited, the tests tagged with the task's scenarios, and the tests named after the task's files or after any source file the change has edited. They run through a per-file command: `commands.targeted: <runner> {files}` in `.wingman-spec/wingman-spec.yaml`, else a template derived from the test command for vitest, jest, mocha, ava, node --test, pytest, rspec, deno, bun and go. When no template is known, the check notes it and runs no tests.
- At the check that ends a task group: typecheck and lint, with incremental flags where the tool has them (`tsc --incremental`, `eslint --cache`).
- At a review task: the full test suite, typecheck and lint.
- For a task that names a `Visual:` scenario or edits a UI file: the visual check of its own scenarios.
- At `finish`: every project command once (a cache hit when the tree is unchanged), every visual scenario of the change, every other declared scenario against the state before the change, and the review gates.

A project whose suite is slow can set `commands.test_run: finish` (or `WINGMAN_SPEC_TEST_RUN=finish`): `check` then runs
only the task's `Done when:`, and the whole suite runs once at `finish`. A task that breaks another test is then found at
`finish`, not at its own check.

## Defaults and what they move

`finish` runs every project command and every declared scenario, so each fault is caught by `finish` at the latest. `tests/verify-task.sh` seeds 15 faults and catches all 15 at the check with `check_level: task`; `tests/targeted.sh` shows a fault in a targeted test caught at the check and one in any other test caught at `finish` with the default; `tests/runfreq.sh` and `tests/visual-cache.sh` cover the levels.

| Default | Opt-in for the stricter gate | What moved |
|---|---|---|
| `check_level: targeted` | `commands.check_level: group` or `task` (or `WINGMAN_SPEC_CHECK_LEVEL`) | a break in a test that no task targets is found at `finish`; a typecheck or lint break in a task that does not end its group is found at the group's last check. A break in a targeted test is still found at the task's check |
| `visual.scope: task` | `visual.scope: all` | a regression in another declared scenario (3 seeded: hidden count, page scrolling sideways, demoted heading) is found at `finish`, not at the task's check |
| `visual.changed_only: on` | `visual.changed_only: off` | an identical passing visual run is not repeated; files the tree does not hold (a dependency, data or environment change) are not seen. Never applies when screenshots go to the visual review or a scenario has a `role:` |
| `visual.request_timeout: 3` | `visual.request_timeout: 0` | a request slower than 3 s is reported as failed |
| `visual.baseline: off` | `visual.baseline: on` | nothing: every defect still fails |

`--per-task` (one task per dispatch) stays opt-in; it changes dispatches, not the check level. `commands.test_run: finish` moves only the project tests to `finish`.
