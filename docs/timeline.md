# Timeline

A change's timeline is `runs/<change>/timeline.jsonl`, one JSON line per event, from the start of `/spec-propose` to archive. Each line has the local ISO time, the session, the task, the result, a one-line summary, the duration and short details (failures, files, output; capped at 4,000 characters). `archive` copies the file next to the archived change.

## What is recorded

- **Planning commands**: `new`, `instructions`, `validate`, `lint`, `size` and `app-map` each append their event, with the result.
- **Artifacts**: before each of those commands and each `log`, the CLI compares the artifacts with the last snapshot (`artifacts-snapshot.json`). Each file written, rewritten or deleted becomes one `artifact` event. A rewritten spec lists the scenarios and ```` ```visual ```` blocks added or removed, so a visual block lost during the design shows.
- **Agent steps** that no command sees: the skills run `wingman-spec log <change> <event> "<summary>"` with `start`, `explore`, `grill`, `approval` or `note`.
- **Build**: every apply-loop step: run start, task picked (`next`), check start and result, fix round, tick, review, finish, sync and archive.
- **Editor buttons**: the extension runs the CLI with `WINGMAN_SPEC_SOURCE=editor`, so its Validate, Status, Sync and Archive appear with `source: editor`.

## Plan changes during the build

At `next`, `check` and `finish` the verifier compares the plan with the last snapshot (`plan-snapshot.json`): requirements and their Why, scenarios, task lines, ADRs and `design.md`. A difference becomes one `decision` line that lists what changed and the reason. The reason comes from `--reason "<text>"`, else from the last `Decision: <what and why>` line in the proposal, design or tasks, else from the heading of an added ADR. A changed Why or a removed requirement also records `owner_approval` (`missing` when nobody gave one). The first command of a change only stores the snapshot.

## Tamper evidence

Each line carries `prev`, the SHA-256 of the line before it (64 zeros for the first). Writers take a short lock file, so parallel commands keep the chain. `wingman-spec validate <change>` and `doctor` warn about a broken chain and name the first entry that does not follow the one before it; the Timeline tab shows the same note. An edited, deleted, inserted or reordered entry breaks the chain. Lines written before 0.12 have no `prev` and are accepted.

This is evidence, not protection. Anyone who can write the file can rewrite it whole with a fresh chain, and an edit of the last entry only shows against an anchor. `archive` anchors the head: `archived.json` records `timeline_head` and `timeline_entries`, and the archive output prints the head so you can put it in the commit message (`Timeline-Head: <hash>`). Once that is committed, git history shows any later change.

## In the editor

The change page and every archived change have a **Timeline** tab. It groups the events by phase (Propose, Build, Verify, Sync, Archive), then by task, and shows results, durations and the gap since the previous step. Idle periods over 15 minutes are marked; details open on click.
