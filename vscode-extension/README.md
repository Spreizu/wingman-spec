# Wingman Spec

See and steer OpenSpec changes from the editor: tasks, specs, decisions, what was verified, and what happened while a change was built.

## Requirements

- A workspace with an OpenSpec project (`openspec/config.yaml`) set up with the Wingman Spec schema and scripts (`install.sh` of the Wingman Spec package).
- Node on the PATH for the read-only verifier calls; git for the branch review.

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

## Commands

| Command | Does |
|---|---|
| Open Dashboard, Open ADR Hub, Browse Specs, Open History | Open a page. |
| Open Branch Review, Open Roadmap (new product) | Open those pages. |
| New Change, New ADR, Supersede ADR | Create a change or an ADR from the templates. |
| Promote Change ADRs, Promote ADR | Copy change ADRs into the project ADR folder. |
| Refresh, Refresh Problems | Read the files and verifier findings again. |
| Run Tests for Requirement, Tag a Test with a Scenario, Accept Drift Gap | Act on one requirement or gap. |

All commands start with **Wingman Spec:** in the Command Palette.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| wingmanSpec.diagnostics | on | Problems in specs, tasks and ADRs |
| wingmanSpec.codeLens | on | CodeLens on tasks, specs and ADRs |
| wingmanSpec.codeView | on | CodeLens, hover and warnings for `@spec` markers and test tags |
| wingmanSpec.runTestsLens | on | A Run tests action on markers |
| wingmanSpec.problemsPanel | on | Verifier findings in the Problems panel, with quick fixes |
| wingmanSpec.dashboardChecks | on | The change page asks the verifier what blocks the archive |
| wingmanSpec.branchReviewBase | empty | Base branch of the branch review (empty: main or master) |
| wingmanSpec.branchReviewGit | on | The branch review may run read-only git |
| wingmanSpec.verifierNode | node | Node used for verifier calls |
| wingmanSpec.verifierTimeoutSeconds | 30 | Time limit of verifier and git calls |
| wingmanSpec.adrDirectory | adr | Folder of promoted ADRs |
| wingmanSpec.openspecPath | openspec | Path to the OpenSpec CLI |

## Troubleshooting

Nothing shows up: open the folder that contains `openspec/config.yaml` (or its workspace), trust the workspace, and run **Wingman Spec: Refresh**.
