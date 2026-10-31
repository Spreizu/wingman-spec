# Wingman Spec

See and steer Wingman Spec changes from the editor: tasks, specs, decisions, what was verified, and what happened while a change was built.

## Requirements

- A workspace set up with **Wingman Spec: Set Up This Folder** (`wingman-spec init`): `.wingman-spec/wingman-spec.yaml` next to the code, a specs repository with `wingman-spec.yaml` at its root, or a code repository linked to one.
- Nothing else to install for the CLI: each platform build (Linux, macOS and Windows, x64 and arm64) bundles `wingman-spec` and always runs it. The extension keeps each project's shim `.wingman-spec/bin/wingman-spec` pointing at it and logs that in the **Wingman Spec** output channel.
- git for the branch review.

The extension reads local files only. It sends nothing over the network and collects no telemetry.

## Views and pages

Open the dashboard from the **Wingman Spec** status bar item or with **Wingman Spec: Open Dashboard**.

| Page or view | What it shows |
|---|---|
| Overview | Changes by state, blockers, ADRs that need syncing, recently shipped changes. |
| Change | Proposal, tasks (click to tick), specs with diffs, design, ADRs, app map, progress, and a summary of checks, review, size and what blocks the archive. |
| Timeline (change and archived change) | Every step of the build in order: task picked, checks with results and durations, fix rounds, reviews, finish, archive, and plan changes made mid-build with their reason. Details expand on click. |
| ADRs | Promoted decisions as a list and as a supersede graph, with change ADRs waiting to be promoted. |
| Specs | Each capability's requirements and scenarios, with pending changes. |
| History | Archived changes by month, each with its tasks, specs, ADRs and timeline. |
| Branch review | Requirements the current branch touches, their Why, changed code anchors and findings in the diff. |
| Roadmap | For a new product: slices in build order and the one that is next. |
| Requirements & Traceability (Explorer) | Requirements with their Why and code and test anchors, pending changes, drift gaps. |
| In the editor | Problems, CodeLens, hover and go-to-definition for spec files, tasks, ADRs and `@spec` markers in code. |

Buttons with a prompt sign run the CLI here: Validate, Status, Sync and Archive on a change, Doctor on the Overview. A
button that cannot run yet is disabled and the line under it says why. Archive asks first. Buttons with a speech bubble
and a dashed border hand the work to the agent chat (plan, apply, fix, resolve a sync conflict). In an untrusted
workspace the CLI is not run.

## Commands

| Command | Does |
|---|---|
| Open Dashboard, Open ADR Hub, Browse Specs, Open History | Open a page. |
| Open Branch Review, Open Roadmap (new product) | Open those pages. |
| New Change, New ADR, Supersede ADR | Create a change or an ADR from the templates. |
| Promote Change ADRs, Promote ADR | Copy change ADRs into the project ADR folder. |
| Refresh, Refresh Problems | Read the files and CLI findings again. |
| Run Tests for Requirement, Tag a Test with a Scenario, Accept Drift Gap | Act on one requirement or gap. |

All commands start with **Wingman Spec:** in the Command Palette.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| wingmanSpec.diagnostics | on | Problems in specs, tasks and ADRs |
| wingmanSpec.codeLens | on | CodeLens on tasks, specs and ADRs |
| wingmanSpec.codeView | on | CodeLens, hover and warnings for `@spec` markers and test tags |
| wingmanSpec.runTestsLens | on | A Run tests action on markers |
| wingmanSpec.problemsPanel | on | CLI findings (`wingman-spec problems`) in the Problems panel, with quick fixes |
| wingmanSpec.dashboardChecks | on | The change page asks the CLI what blocks the archive |
| wingmanSpec.branchReviewBase | empty | Base branch of the branch review (empty: main or master) |
| wingmanSpec.branchReviewGit | on | The branch review may run read-only git |
| wingmanSpec.verifierTimeoutSeconds | 30 | Time limit of CLI and git calls |

## Troubleshooting

Nothing shows up: open the folder that contains `.wingman-spec/wingman-spec.yaml` (or its workspace), trust the workspace, and run **Wingman Spec: Refresh**.
