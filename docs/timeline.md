# Timeline

Every `verify-task` step of a change appends one JSON line to `openspec/.apply-runs/<change>/timeline.jsonl`: run start, task picked (`next`), check start and result, fix round, tick, review, finish, sync and archive. Each line has the local ISO time, the session, the task, the result, a one-line summary, the duration and short details (failures, files, output; capped at 4,000 characters). Lines are appended one at a time, so parallel sessions do not overwrite each other. `archive` copies the file next to the archived change.

## Plan changes during the build

At `next`, `check` and `finish` the verifier compares the plan with the last snapshot (`plan-snapshot.json`): requirements and their Why, scenarios, task lines, ADRs and `design.md`. A difference becomes one `decision` line that lists what changed and the reason. The reason comes from `--reason "<text>"`, else from the last `Decision: <what and why>` line in the proposal, design or tasks, else from the heading of an added ADR. A changed Why or a removed requirement also records `owner_approval` (`missing` when nobody gave one). The first command of a change only stores the snapshot.

## In the editor

The change page and every archived change have a **Timeline** tab. It groups the steps by task and shows results, durations and the gap since the previous step. Idle periods over 15 minutes are marked; details open on click.
