# Why a check or a finish takes the time it takes

`verify-task` runs the project's own commands (tests, typecheck, lint, a task's `Done when:`) and a set of scans of its own. Measured in a project of 4,400 files with 300 requirements and a test command that sleeps 20 seconds (so the project's suite is a fixed 20 s and everything above 20 s is ours), the scripts' own work was about 1 s per `check`; the rest was the suite, run more often than needed. `SPEC_PROFILE=1` (or `--timing`) prints what each command and scan cost, most expensive first, and records it in the run's `metrics.jsonl` (`event: profile`).

| Command | 0.10.3 | 0.11.0 | 0.11.1 |
|---|---|---|---|
| `check`, one task | 21.0 s | 21.0 s | 21.0 s |
| `check`, two tasks naming the same test command (total; one batch in 0.11) | 42 s | 41.4 s | 21.3 s |
| `finish` after the checks | 21.1 s | 20.8 s | 0.9 s |
| `sync` | 9.5 s | 8.5 s | 0.3 s |
| `archive` | 9.1 s | 8.9 s | 0.8 s |

What was ours:

- A `Done when:` that is the project's test command ran once per task of a batch and never reached the result cache, so `finish` ran it again. Now one command runs once per tree (the second task says "same command"), and a `Done when:` equal to the project's tests, typecheck or lint command shares the cache entry that `finish` reads. The key is the hash of the working tree without the run state and the change's `tasks.md` / `progress.md`, so ticking a box does not invalidate it; any other edit, a failing result and `--no-cache` do.
- `sync` and `archive` ran the stale-anchor drift, which blames every anchored file (`git blame -w -M -C -C`, about 8 s for 400 files). They now run the drift without it (the stale-anchor list is advisory and `drift` still prints it), and `drift` keeps its blame results in the git directory, keyed by the file, its copies and its content and emptied when HEAD moves, so a second `drift` takes 0.35 s.
- On a large repo the working-tree hash ran `git add -A` into a temporary index, reading and copying every untracked file into `.git`. Measured on 50,066 tracked files plus 1.7 GB of untracked data: `next` 40.7 s -> 0.35 s, the first `check` 31.8 s -> 1.6 s, `finish` 4.7 s -> 0.9 s, and `.git` no longer grows by 1.7 GB. The hash now reuses the real index and adds untracked files by name, size and mtime.
- Live progress: a command running for 3 s is announced on stderr and then every 15 s with the elapsed time, and its end is printed. `--timeout SEC` or `SPEC_TIMEOUT_<TESTS|TYPECHECK|LINT|DONE_WHEN|VALIDATE>` limits one command.

What is not ours: the project's own test, typecheck and lint time. A task's `Done when:` and the project tests are two regression gates; the second runs at every `check` by default. A project whose suite is slow can put `- Test run: finish` under the test command in `openspec/config.yaml` (or `SPEC_TEST_RUN=finish`): `check` then runs only the task's `Done when:`, and the whole suite runs once at `finish`. That removes the per-task regression gate (a task that breaks another test is found at `finish`, not at its own check), so it is the project owner's decision; the default is unchanged.

# A visual check on a page with defects that are not the task's

Measured on one page with 80 failing images, 3 images whose request never answers, 3 console errors, axe violations and a 2,000 px bar, one scenario with 3 states at 3 widths (9 captures):

| | 0.10.3 | 0.11.1 (no request limit) | 0.11.2 default (`request_timeout: 3`) | `request_timeout: 1` |
|---|---|---|---|---|
| `visual` | 31.3 s | 10.9 s | 8.9 s | 7.2 s |
| defects reported | 1,030, none of them an axe, overflow or image check | 1,071 | every check runs, as in 0.11.1 | 1,092 |

Cause: with `waitUntil: 'load'`, a request that never answers keeps the load from completing. Every state at every width waited the 5 s limit, then 5 s more for the network to go idle. It then reported only "could not open" and ran no check on the page, so an axe or key-element defect of the task was invisible behind it.

Now the first state waits once and says what it waits for. Every check runs on the page as it stands, and later captures abort that URL at once (the defect is reported where it first hung). A request still open after `request_timeout` seconds (default 3) is aborted and reported as a failed request; `0` waits up to `page_timeout` (default 5 s). A request or console error that repeats in a later state of the same viewport is reported once, and the report counts the repeats (`perf`). One browser is launched per run. Each state and viewport keeps its own context, because each state needs its own cookies and storage; that cost is small next to the waits.

`visual.baseline: on` (default off) compares with the capture taken before the task. A request, HTTP, console or axe defect that was already there, identical in state, viewport and message, is listed once with a count and does not fail the task; so is an axe defect outside the scenario's key elements. A defect the task adds, an axe defect inside a key element, overflow, a broken image, a missing key element and every `expect:` / `absent:` / role / step defect still fail. With the default every defect on the page fails. Whether to trust the capture before the task is the project owner's decision, so it stays off.

# How often the tests and the visual check run

Audit on the synthetic project above: 4,400 files; tests 20 s, typecheck 4 s, lint 2 s, each `Done when:` 1 s; a change of 5 tasks in two groups. Runs are tests / typecheck / lint / `Done when:` over the whole change, `finish` included.

| Setup | Runs | Wall time |
|---|---|---|
| 0.10.3, one task per dispatch (always) | 6 / 6 / 6 / 5 | 166 s |
| 0.11.1 default, `--per-task` | 5 / 5 / 5 / 5 | 142 s |
| 0.11.2 default (`Check level: targeted`), one task per dispatch | 1 / 2 / 2 / 5 | 42 s |
| 0.11.2 default, one group per dispatch | 1 / 2 / 2 / 5 | 39 s |
| `Check level: group`, one task per dispatch | 2 / 2 / 2 / 5 | 63 s |
| `Check level: task`, one task per dispatch | 5 / 5 / 5 / 5 | 140 s |
| `Check level: finish` | 1 / 1 / 1 / 5 | 30 s |

What the result cache skips: an identical repeat only, such as `finish` after the last `check` with no edit in between. Between two tasks the tree differs, so each check that runs the project's commands runs them.

What runs when:

- At every `check`: the `Done when:` of each task of the dispatch and the static scans (traceability, anchors, size, plan lint).
- At every `check` (default `Check level: targeted`): the task's targeted tests only. These are the test files the change added or edited, the tests tagged with the task's scenarios, and the tests named after the task's files or after any source file the change has edited. They run through a per-file command: `- Targeted test command: <runner> {files}` in `openspec/config.yaml`, else a template derived from the test command for vitest, jest, mocha, ava, node --test, pytest, rspec, deno, bun and go. When no template is known, the check notes it and runs no tests.
- At the check that ends a task group: typecheck and lint, with incremental flags where the tool has them (`tsc --incremental`, `eslint --cache`).
- At a review task: the full test suite, typecheck and lint.
- For a task that names a `Visual:` scenario or edits a UI file: the visual check of its own scenarios.
- At `finish`: every project command once (a cache hit when the tree is unchanged), every visual scenario of the change, every other declared scenario against the state before the change, and the review gates.

The visual check is the larger cost on a UI change. Measured on 5 tasks, each with its own scenario at 2 widths, plus 4 guard specs on the same page:

| `visual.scope` | Checks of tasks 1 to 5 | `finish` | Wall time | State captures |
|---|---|---|---|---|
| `all` (0.11.1 default) | 9, 10, 11, 12, 14 s | 9 s | 120 s | 150 |
| `task` (0.11.2 default) | 3 s each | 28 s | 55 s | 56 |

With `scope: all` each check repeats the captures of the earlier tasks and the guards. `visual.changed_only` saves nothing in this run, because every task edits the page; it pays on a retry and on a `finish` with the same plan.

## A slow test suite

A project whose suite takes 60 s (a 5-task change, Size M, `node --test` with one slow file):

| Setup | Checks of tasks 1 to 5 | `finish` | Whole change |
|---|---|---|---|
| `Check level: task` | 61, 61, 61, 61, 61 s | cached | 307 s |
| `Check level: group` (0.11.2 before this) | 0.8, 0.7, 61, 0.6, 61 s | cached | 126 s |
| `Check level: targeted` (default) | 0.9, 0.8, 0.8, 0.8, 0.7 s | 60.5 s | 66 s |

Incremental typecheck on 1,500 TypeScript files, one leaf file edited: `tsc` 5.9 takes 3.0 s without `--incremental` and 1.3 s with it; the native TypeScript 7 compiler shows no gain. The flags are written by `install.sh` when it detects the typecheck and lint commands.

## Defaults and what they move

`finish` still runs every project command and every declared scenario, so each fault is caught by `finish` at the latest. `tests/verify-task.sh` seeds 15 faults and catches all 15 at the check with `Check level: task`; `tests/targeted.sh` shows a fault in a targeted test caught at the check and one in any other test caught at `finish` with the default; `tests/runfreq.sh` and `tests/visual-cache.sh` cover the levels.

| Default | Opt-in for the stricter gate | What moved |
|---|---|---|
| `Check level: targeted` | `- Check level: group` or `task` (or `SPEC_CHECK_LEVEL`) | a break in a test that no task targets is found at `finish`; a typecheck or lint break in a task that does not end its group is found at the group's last check. A break in a targeted test is still found at the task's check |
| `visual.scope: task` | `visual.scope: all` | a regression in another declared scenario (3 seeded: hidden count, page scrolling sideways, demoted heading) is found at `finish`, not at the task's check |
| `visual.changed_only: on` | `visual.changed_only: off` | an identical passing visual run is not repeated; files the tree does not hold (a dependency, data or environment change) are not seen. Never applies when screenshots go to the visual review or a scenario has a `role:` |
| `visual.request_timeout: 3` | `visual.request_timeout: 0` | a request slower than 3 s is reported as failed |
| `visual.baseline: off` | `visual.baseline: on` | nothing: every defect still fails |

`--per-task` (one task per dispatch) stays opt-in; it changes dispatches, not the check level. `- Test run: finish` still moves only the project tests to `finish`.
