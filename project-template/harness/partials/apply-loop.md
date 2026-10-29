**The loop.** `V` below is `node <code-repo>/openspec/scripts/verify-task.cjs` (add `--root <root>` if the OpenSpec root is not detected). Run it from the code repository. Pick one short session id for this conversation, for example `a7f3`, and add `--session <id>` to every `V` call. A second agent on the same change is then refused instead of overwriting your run. `V` is the only judge of progress: it counts tasks with `openspec instructions apply --json` and re-runs every check itself.

1. `V next <change> --format prompt`. Act on the exit code:
   - `0`: the output is the subagent's whole task. One dispatch is the whole change for Size S, one task group for Size M/L, or a review task alone. It lists each task's `Done when:`, the files to read and, on a retry, the previous failure. Continue with step 2. For a UI task, `next` first records the pre-task DOM, ARIA and clips of the declared visual scenarios. Change nothing in the code repository between `next` and the subagent.
   - `10`: every task is done. Go to **Finish** (`V finish <change>`; there are no agent close-out tasks).
   - `3`: `BLOCKED.md` exists. Show it to the user with its `Proposed outcome:` line (redo, amend or accept), tell them to run `/spec-fix`, and stop.
   - `4`: this task failed its last allowed attempt. Stop and report (below).
   - `2` with `"result": "unverified-ticks"`: `tasks.md` has a ticked task that no `check` passed. `next` never skips it. If the message names the current task, run `V check <change> --reported done` now; after a failed check, `check` opens the next attempt itself. For any other task, untick it and run `next` again.
   - `2` with `"result": "run-owned"` or `"busy"`: another session or worktree owns the open run of this change, or another `V` command is running on it now. Stop and tell the user which run it is; the message names its session, worktree, commit and start. Do not start a second run and do not edit `tasks.md`. Only when the user says the other run is dead, repeat the command with `--takeover`.
   - `2` otherwise: show the message and stop. The causes:
     - a usage or environment error;
     - checkboxes in `tasks.md` that OpenSpec would miscount (in code fences, or nested), or a broken ```` ```visual ```` block or `Visual:` line: fix the plan with `/spec-fix`;
     - a placeholder in `openspec/config.yaml` that the task needs (`Test command:`, or `visual:` `command`/`url` for a task with a `Visual:` line): ask the user for the value and fix the file. `V doctor` lists what is missing.
2. **Dispatch one subagent** with that prompt (`next --per-task` hands out one task per dispatch), in the foreground, never two at a time, never resumed:
   - Claude Code and Cursor: the Task tool with the `spec-implementer` subagent.
   - Codex: spawn one `spec-implementer` agent with the prompt and wait for it.
   - No subagent support (subagents disabled, or a client without delegation): the **sequential fallback**. Do the dispatch's tasks yourself, in this turn only, by following `spec-implementer`'s instructions (in `.cursor/agents/`, `.claude/agents/` or `.codex/agents/`). Re-read the files listed in the prompt; do not rely on earlier context. One dispatch per turn.
3. When it returns, read its last line: `STATUS: done|failed|blocked`. A missing line counts as `failed`. Run `V check <change> --reported <status>`. Do not judge the work yourself first. The script, each step with a timeout:
   - compares `tasks.md` with its snapshot and re-runs each `Done when:`;
   - runs the project tests, typecheck and lint at the levels set in `openspec/config.yaml` (skipping one that `Done when:` already ran);
   - applies the test-quality rules: changed tests must not read source files as text, and every scenario the `Spec:` line names needs a test tagged `[capability/scenario-slug]`;
   - runs the **visual check** for a task with a `Visual:` line or changed UI files. It starts the app from `visual:` in `openspec/config.yaml` and opens the task's scenario states at each viewport, without screenshots. It fails on console and page errors, failed requests, axe violations, sideways scrolling, broken images, and key elements that are missing, hidden, off-screen or overlapping. Against the pre-task capture, it also fails on new defects or ARIA changes in declared scenarios outside the task's scope. A review task's scope is every file named in a `Files:` line of the change;
   - runs `openspec validate --strict`.
   - `0`: passed; the script ticked the dispatch's tasks. Go to step 1.
   - `5`: the deterministic checks passed and the task has visual scenarios: **visual review**. The output names `review_prompt`, a file with the scenarios, the before and after clips of the task's areas, their ARIA diff, the design reference with side-by-side images, and the rubric. Go to step 4.
   - `1`: rejected. To re-check a fix made in this same turn, run `V check <change> --reported <status>` again; it opens the next attempt. Otherwise go to step 1: `next` returns the same task, with the failure output in the prompt for a fresh subagent. Each visual defect is one line naming scenario, state and viewport.
   - `3` or `4`: stop and report.
   The output may carry `warnings` (e.g. `VISUAL CHECK SKIPPED: Playwright is not installed`): repeat them to the user in your report; never present a skipped visual check as passed.
   Certificate errors never fail the visual check by default (`visual.ignore_https_errors: true`), so a self-signed https dev server is fine. Do not add flags or workarounds for them.
   Never edit `tasks.md` yourself, never tick a box, never skip `check`.
4. **Visual review** (only after exit `5`, which needs `visual.review: subagent` in `openspec/config.yaml`; the default `off` never asks). An INDEPENDENT reviewer does it, never the agent that wrote the code and never you:
   - Claude Code and Cursor: the Task tool with ONE fresh `spec-visual-reviewer` subagent, in the foreground, prompt "Review the before/after images as described in `<review_prompt>`."
   - Codex: spawn one `spec-visual-reviewer` agent with that prompt and wait for it.
   - No subagent support (the sequential fallback): do NOT review the images yourself. Run `V review <change> --reviewer none`. It records the review as skipped, and the task passes on its deterministic checks (DOM, ARIA, geometry, `expect:`). Tell the user the visual review was skipped. (`--reviewer self` is refused.)
   Save the reviewer's whole reply to a file, then run `V review <change> --reply <file>`.
   - `0`: passed. Go to step 1.
   - `1`: rejected like a failing test: the reviewer's defects go into the next attempt's prompt (same 3-attempt limit). Go to step 1.
   - `4`: stop and report.
   - `2`: nothing was recorded. The reply had no `STATUS:` line, `STATUS: fail` without a `DEFECT:` line, an incomplete design rubric, or `STATUS: error` (the reviewer could not open the images). Ask the reviewer once more. If it still cannot review, run `V review <change> --reviewer none`.

**Exit codes are not shell failures.** `5` (review pending) and `10` (all done) are normal results. Never chain `V next` or `V check` with `&&`: a `5` stops the chain. Run each command on its own and read its exit code (`echo $?`), then act on the table above.

**Stop and report.** Every `next`, `check`, `review` and `finish` result carries `run_status`: own run, a run of another session, or a takeover. A finished change carries a `status` line: which run verified it, at which commit, and whether the working tree still matches. Quote these instead of guessing who verified what. Show the user:
- the last `check` or `review` output: failures and the checks table;
- what the subagent said;
- for a visual failure, the visual `report.json` and any area images;
- the run log path (`<root>/openspec/.apply-runs/<change>/`).
Suggest `/spec-fix` when the task or spec looks wrong. After the cause is fixed, restart with `V next <change> --new-run`.
