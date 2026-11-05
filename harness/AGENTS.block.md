<!-- WINGMAN-SPEC:START -->
## wingman-spec workflow

This project plans and verifies its work with Wingman Spec. The CLI is `.wingman-spec/bin/wingman-spec` (a shim to the installed
binary); the settings are in `.wingman-spec/wingman-spec.yaml`. Managed block: `wingman-spec update` rewrites it; do not edit it by hand.

Bundled skills (`.claude/skills/` or `.agents/skills/`; invoke by name, follow the inline fallback if one is
missing): `wingman-grilling`, `spec-writing`, `wingman-test-driven-development`, `wingman-ponytail`, `wingman-systematic-debugging`, `wingman-requesting-code-review`,
`wingman-ponytail-review`, `wingman-verification-before-completion`, and `figma-to-code` (a Figma URL as design source).

### Commands

In Codex they are skills: `$spec-apply <change>` instead of `/spec-apply <change>`.

| Command | What it does |
|---------|--------------|
| `/spec-explore [topic]` | Think and decide, driven by `wingman-grilling`. No code, no artifacts; works in plan mode. |
| `/spec-propose <change>` | Creates the change and its artifacts: proposal, specs, tasks, plus app-map, design and ADRs unless the change is on the fast path (Size S, `Risk: none`, no sensitive path, no UI). |
| `/spec-apply <change>` | Test-first, one fresh `spec-implementer` subagent per dispatch (the change at Size S, a task group from Size M up, parallel waves for tasks with separate files); `wingman-spec check` decides each one. |
| `/spec-fix [change] [findings]` | Post-QA: classify findings (`code-bug` redo, `spec-mistake` amend, accepted deviation, `new-work`), confirm with the user, patch specs and tasks or open a follow-up change. Never writes `specs/` or `adrs/`. |
| `/spec-archive <change>` | `wingman-spec archive`: gates (tasks, findings, finish on this tree, lint, a clean merge), merges the specs and ADRs, archives. |
| `/spec-sync <change> [--check]` | Inspects a merge, or fixes one the archive refused (`sync --rebase`). |
| `/spec-garden [--check]` | Takes the drift report (code anchors vs specs vs tests); fixes each gap or accepts it (an `Accepted:` line on the requirement). |
| `/spec-adopt [scope] [--check]` | Brownfield, one-off: baseline specs and ADRs. Only confirmed behaviour (test, doc, owner) becomes a requirement; bugs, debug leftovers and unclear behaviour go to `observed/<capability>.md`. Never overwrites a spec. |
| `/spec-green-start` | New product, no code yet: the analyst's only command. Run it again and again; it reads `wingman-spec greenfield status` and does the one next step, up to `READY FOR HANDOVER`. |
| `/spec-green-plan` | After the specs are approved: the roadmap of slices in `roadmap/`. |
| `/spec-green-next [slice]` | After handover: builds the next unblocked slice (a change with tasks, no spec deltas). Never replans. |

### Rules that always apply

- **Specs root.** `wingman-spec root --json` names it. Next to the code it is `.wingman-spec/` (`specs/`, `changes/`, `archive/`,
  `adrs/`). A code repository linked to a specs repository (`specs: <path>` in its config) reads and writes them there. If the
  CLI reports a missing specs folder, show its text (it names the `git clone` step) and stop; never clone or guess a root.
- **Two roles.** Analyst (explore to tasks): concrete, testable specs and self-contained tasks for junior developers. Implementer
  (apply): executes tasks test-first and never changes specs or ADRs except via `/spec-fix`.
- **Explore: grill first.** Keep grilling (`/spec-explore`) until every decision branch is resolved, then write artifacts.
  Fallback: numbered interview rounds with a recommended answer each; stop only when nothing is left assumed.
- **The CLI writes the specs.** `wingman-spec archive` merges deltas, promotes ADRs and archives. Never merge a delta, copy an
  ADR or move a change folder by hand.
- **New product (greenfield).** Spec-only changes say `Kind: spec-only`; slices say `Slice: <id>`. Before any greenfield
  command run `wingman-spec mode --for <start|plan|next>`: exit 6 means the project is not greenfield (existing code, archived
  changes, or already implemented); print its text and stop, write nothing. Never review your own specs: use `spec-reviewer`.
- **No commits.** Never commit, stage, stash, reset or switch branches: every change of a run stays uncommitted in the working tree for the user to review and commit.
- **Blocked means stop.** If something is wrong that you cannot fix inside the specs, write it to `BLOCKED.md` and stop; do not
  improvise around the specs.

### Per task: test-first, smallest change, verified

- `wingman-test-driven-development`: a failing test from `Test first:`, then minimal code.
- `wingman-ponytail` (full): name skipped extras, do not question the spec.
- `wingman-systematic-debugging` on an unexpected failure or after two failed fixes.
- `wingman-verification-before-completion`: run `Done when:` and read its output.
- A `Request code review` task: reviewer subagent (`wingman-requesting-code-review`), then `wingman-ponytail-review`. Fix the findings that review lists before you reply.

`spec-implementer` has the detail.

### Apply loop (`/spec-apply <change>`): orchestrator, subagent, CLI

The main agent orchestrates. The CLI decides whether a task is done.
Follow `/spec-apply` for the steps, the exit codes and the visual review.

UI work: scenarios carry a ```` ```visual ```` block and tasks a `Visual:` line; run `wingman-spec visual <change>` before ticking.
Browsers run headless only, so the owner's screen stays free: never `--headed`, `--debug`, `PWDEBUG`, `open <url>`, or a browser tool
or MCP that shows a window. The visual check is headless; a Playwright script of your own passes `headless: true`.
A design to match: `/spec-explore` maps it to project tokens and components first (`wingman-spec design-system`); a Figma URL
uses `figma-to-code`. HTTPS dev servers with self-signed certificates work. Nothing is stored in the repository (no baselines).
A defect the change does not own (third-party widget, page chrome) may be skipped with `ignore:` / `ignore-http:` in the visual
block or `visual.ignore` / `visual.ignore_http` in the config (a11y:, runtime:, content:, horizontal overflow only; listed as
"ignored (n)", never silent); never to pass your own defect.
A UI-facing proposal answers its `## UX checklist` (loading, empty, error, disabled, validation, recovery, keyboard, narrow, long-text): a scenario or `Not applicable: <reason>`.

### Traceability (`traceability: on|warn|off`)

Every requirement says `Why: <who wants it, and why>` on one line under its SHALL sentence. Rewriting the Why of an existing
requirement, or removing a requirement, needs `Owner approval: <name>, <date>` in the proposal, added only after the owner agreed.
Put `@spec <capability>/<requirement-slug>` in one comment on the function that decides the requirement's behaviour, once per code
path. Never on an import, constant, type, string table or log line. Put it in the test that proves it too, or tag the test
`[capability/scenario-slug]`. The CLI checks both. `/spec-garden` fixes or accepts each drift gap. Where a marker goes: the
`spec-implementer` agent. A requirement's `ID:` line is written by `lint --fix`; never edit or reuse one. `@spec <ID>` works
like the slug and survives renames.

Apply runs: pass `--session <id>` (one id per conversation) to every `wingman-spec` call. A run owned by another session or
worktree is refused (`run-owned`), and so is a command already running on the change (`busy`). Never start a second run. Use
`--takeover` only when the user says the other run is dead.

### Reference

`wingman-spec help reference` prints the exit codes, every check rule, the run state and the config keys; `wingman-spec <command>
--help` the options of one command. `wingman-spec doctor` shows what is missing in the config and environment. Run `lint <change>
--text`, `trace` and `run-checks` and fix what they report. `wingman-spec instructions <artifact> <change>` and the `/spec-*` commands carry the detail
for each stage.
<!-- WINGMAN-SPEC:END -->
