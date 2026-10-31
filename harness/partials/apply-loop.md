**The loop.** `W` below is `.wingman-spec/bin/wingman-spec`, run from the code repository. Pick one short session id for this conversation (for example `a7f3`) and pass `--session <id>` to every `W` call, so a second agent on the same change is refused instead of overwriting your run. `W` alone decides progress: it reads `tasks.md` and re-runs every check itself. Never edit `tasks.md`, never tick a box, never skip `check`.

1. **`W next <change> --format prompt`**, then act on the exit code:
   - `0`: the output is one dispatch: the whole change at Size S, one task group at Size M/L, a review task alone, or one task with `--per-task`. It holds each task's `Done when:`, the files to read and, on a retry, the last failure. Go to step 2 and change nothing in the code repository before the subagent starts (`next` has captured the pre-task state of the task's visual scenarios).
   - `0` and a first line `WAVE <n>: <k> tasks (...)`: a **parallel wave**. Tasks of one group with disjoint `Files:` come as one `=== packet <label> ===` prompt each, up to `parallel:` (default 3). Go to step 2 and dispatch them together.
   - `10`: every task is ticked. Go to **Finish**.
   - `3`: `BLOCKED.md` exists. Show it with its `Proposed outcome:` line, tell the user to run `/spec-fix`, and stop.
   - `4`: the task used its last attempt. Stop and report.
   - `2` with `"result": "unverified-ticks"`: a ticked task that no `check` passed. If it is the current task, run `W check <change>` now; otherwise untick it and run `next` again.
   - `2` with `"result": "run-owned"` or `"busy"`: another session or worktree owns this change's run, or another `W` command is running on it. Stop and tell the user what the message names. Use `--takeover` only when the user says the other run is dead.
   - `2` otherwise: show the message and stop. It is a usage or setup error, a plan `W lint` rejects (fix it with `/spec-fix`), or a `<fill in>` value in `.wingman-spec/wingman-spec.yaml` that the task needs (ask the user, write the value; `W doctor` lists them).
2. **Dispatch.** One fresh `spec-implementer` subagent per prompt, in the foreground, never resumed:
   - Claude Code and Cursor: the Task tool. For a wave, one message with one Task call per packet.
   - Codex: spawn one `spec-implementer` agent per prompt and wait for it.
   - No subagents available: do the dispatch yourself in this turn by following `spec-implementer` (its file is in `.cursor/agents/`, `.claude/agents/` or `.codex/agents/`). Re-read the files the prompt lists. A wave becomes its packets one after another, each followed by its `check`.
3. **Check.** Read the subagent's last line, `STATUS: done|failed|blocked` (missing means `failed`), and run `W check <change> --reported <status>`; in a wave add `--task <label>`, one `check` per returned packet, as each returns. Do not judge the work first. `check` re-runs each `Done when:`, the project's test, typecheck and lint commands at the configured level, the test-quality rules (every scenario the `Spec:` line names needs a test tagged `[capability/scenario-slug]`), the anchor checks, `validate`, and the visual check for a task with a `Visual:` line or changed UI files.
   - `0`: passed and ticked. Back to step 1.
   - `5`: the deterministic checks passed and a visual review is due (`visual.review: subagent`). Go to step 4.
   - `1`: rejected. Back to step 1: `next` hands the same task to a fresh subagent with the failure. To re-check a fix made in this turn, run `check` again.
   - `3` or `4`: stop and report. In a wave, check the other packets first.
   In a wave, the project commands run at the wave's last `check`; a failure there reopens the task whose file it names, or the whole wave.
   Repeat every `warnings` line to the user (for example `VISUAL CHECK SKIPPED: ...`); never report a skipped check as passed.
4. **Visual review**, by an independent reviewer, never by you or the implementer:
   - Claude Code and Cursor: the Task tool with one fresh `spec-visual-reviewer`, prompt "Review the before/after images as described in `<review_prompt>`."
   - Codex: spawn one `spec-visual-reviewer` agent with that prompt.
   - No subagents: `W review <change> --reviewer none` (the task passes on its deterministic checks; tell the user the review was skipped).
   Save the whole reply to a file and run `W review <change> --reply <file>`: `0` passed, `1` rejected (back to step 1), `4` stop, `2` nothing recorded (the reply lacks `STATUS:`, a `DEFECT:` line or the rubric): ask the reviewer once more, then `--reviewer none`.

**Finish.** After `10`, run `W finish <change>`. It runs the full test, typecheck and lint commands, `validate`, the visual check of every scenario, traceability and the test evidence. `1` comes with a `fix_prompt` file: dispatch ONE `spec-implementer` with it, then run `finish` again (3 attempts). A pass prints `"result": "passed"` (or `"finished"` when the tree has not changed since).

**Exit codes are results, not shell failures.** `5` and `10` are normal. Never chain `W` calls with `&&`; run each on its own and read its exit code.

**Stop and report.** Show the user the last `check`, `review` or `finish` output (failures and the checks table), what the subagent said, the visual `report.json` for a visual failure, the `run_status` line (whose run, which commit), and the run folder `runs/<change>/` in the specs root. Suggest `/spec-fix` when the task or the spec looks wrong; after the fix, restart with `W next <change> --new-run`.
