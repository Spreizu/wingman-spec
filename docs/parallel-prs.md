# Parallel PRs: what is stored where

Several people work on separate changes at the same time. This page lists every file the workflow writes and what
happens when two branches both touch the area.

Rules the design follows:

- **Derived data is never committed.** If a tool can compute it from other files, it does, on demand.
- **Living records are one file per record**, with ids that two branches cannot pick twice.
- **Shard by capability** where one file would collect entries from many changes.

| File or feature | Risk when two PRs touch it | Decision |
|---|---|---|
| `@spec` markers and `[capability/scenario]` test tags | Two PRs edit the same source file: an ordinary code merge | They are the anchor index. `verify-task.cjs anchors --json` derives the index from them. Nothing else is stored. |
| `Accepted: <reason>` line on a requirement (`drift decide --accept`) | Two PRs accept gaps | Each line sits inside the requirement it excuses, so accepts of different requirements merge line by line, even in one spec file. Nothing else is stored. `sync-check` ignores the line when it compares requirement text. |
| `openspec/greenfield/records/` (`Q-<topic>.md`, `A-<slug>.md`, `ENV-<name>.md`) | Two analysts add questions, assumptions or environments in parallel | One file per record, named by its author, so different records are different paths and merge cleanly. The same name on both branches is an add/add conflict on that file. The question, assumption and environment lists are derived from the folder. |
| `openspec/specs/<capability>/spec.md` | Two changes edit the same capability | Inherent and intended: the text conflict is where a human must reconcile two requirement changes. `sync-check` fails if a requirement block differs from the change's delta after a merge. |
| `adr/NNNN-*.md` (ADRs) | Two PRs take the same next number | `sync-check` reports duplicate numbers; `verify-task.cjs adrs --fix` renumbers the newer one and its links. Numbers stay because ADRs are cited by number. |
| `adr/README.md` | Index rewritten by every ADR | Static text (no list). The folder listing is the index. |
| `openspec/changes/<name>/` | Same change name in two PRs | Per-change directory. Names are chosen per change, a clash is a normal add/add conflict. |
| `openspec/changes/archive/<date>-<name>/` | Same archive name | Date plus change name, unique per change. |
| `tasks.md` checkboxes | Two people tick tasks of one change | One change has one owner at a time. |
| `openspec/.apply-runs/` (run ledgers, state) | Local run state | Ignored by git (the folder has its own `.gitignore`). |
| Visual baselines and screenshots | Binary conflicts | Not committed (they go to a temporary folder). |
| `openspec/config.yaml` | Rare edits | Normal text merge. |

Dropped on purpose: the drift type `anchored-file-missing` and the "was anchored in" hints. They needed the stored
index. A requirement that lost its anchors is still reported as `unanchored-requirement`.
