<!-- WINGMAN-SPEC:START -->
## wingman-spec workflow

This project uses the OpenSpec schema `wingman-spec` (`openspec/config.yaml` in the OpenSpec root, below).
Managed block: edit via the schema package's `install.sh`, not by hand.

Bundled skills (`.cursor/skills/`, `.claude/skills/` or `.agents/skills/`; invoke by name, follow the inline fallback if one is
missing): `grilling`, `test-driven-development`, `ponytail`, `systematic-debugging`, `requesting-code-review`,
`ponytail-review`, `verification-before-completion`, and `figma-to-code` (a Figma URL as design source).

### Commands

Use these, never the stock `/opsx:*` workflows or `openspec-*` skills (a prompt hook blocks them and names the `/spec-*`
equivalent). In Codex they are skills: `$spec-apply <change>` instead of `/spec-apply <change>`.

| Command | What it does |
|---------|--------------|
| `/spec-explore [topic]` | Think and decide, driven by `grilling`. No code, no artifacts. |
| `/spec-propose <change>` | Creates the change and its artifacts: proposal, specs, tasks, plus app-map, design and ADRs unless the change is on the fast path (Size S, `Risk: none`, no sensitive path, no UI). |
| `/spec-apply <change>` | Test-first, one fresh `spec-implementer` subagent per dispatch (the change when Size S, a task group when M/L), each checked by `openspec/scripts/verify-task.cjs`. |
| `/spec-fix [change] [findings]` | Post-QA: classify findings (`code-bug` redo, `spec-mistake` amend, accepted deviation, `new-work`), confirm with the user, patch specs/tasks or a follow-up change. Never writes `openspec/specs/` or `adr/`. |
| `/spec-sync <change> [--adrs-only] [--check]` | Merges delta specs into `openspec/specs/`, promotes ADRs to `adr/`, runs `verify-task.cjs sync`. Run on its own only to inspect or fix a sync problem: `/spec-archive` runs it first. |
| `/spec-archive <change>` | Runs `/spec-sync` first, then `verify-task.cjs archive` (refuses an unsynced change). |
| `/spec-garden [--check]` | Takes the drift report (code anchors vs specs vs tests); fixes each gap or accepts it (an `Accepted:` line on the requirement). |
| `/spec-adopt [scope] [--check]` | Brownfield, one-off: baseline specs and ADRs. Only confirmed behavior (test, doc, owner) becomes a requirement; bugs, debug leftovers and unclear behavior go to `openspec/observed/<capability>.md`. Never overwrites a spec. |
| `/spec-green-start` | New product, no code yet: the analyst's only command. Run it again and again; it reads `verify-task.cjs greenfield status` and does the one next step, up to `READY FOR HANDOVER`. |
| `/spec-green-next [slice]` | After handover: builds the next unblocked slice of `openspec/roadmap/` (a change with tasks, no spec deltas). Never replans. |

### Rules that always apply

- **OpenSpec root** = the directory containing `openspec/` (config, schema, `specs/`, `changes/`) and the promoted `adr/`.
  Next to code it is this repository. In the workspace layout (`openspec/workspace.yaml` says `specs: <path>`, or `store: <id>` in
  `openspec/config.yaml`) run `openspec` from the root, read and write `openspec/` and `adr/` there, and never create `openspec/specs` or `openspec/changes` here. If `node openspec/scripts/verify-task.cjs doctor`
  prints clone/register steps, show them to the user and stop; do not clone or guess a root.
- **Two roles.** Analyst (explore to tasks): concrete, testable specs and self-contained tasks for junior developers. Implementer
  (apply): executes tasks test-first and never changes specs or ADRs except via `/spec-fix`.
- **Explore: grill first.** Keep grilling (`/spec-explore`) until every decision branch is resolved, then write artifacts.
  Fallback: numbered interview rounds with a recommended answer each; stop only when nothing is left assumed.
- **Sync before archive.** `/spec-sync` does three steps in order: delta specs merge, ADR promotion (idempotent; `status: none`
  is skipped by design), `verify-task.cjs sync <change>` (read-only anchor and drift check).
  `verify-task.cjs archive` is the only way to archive; a bare `openspec archive` cannot be stopped, but `drift` reports it.
- **New product (greenfield).** Spec-only changes say `Kind: spec-only`; slices say `Slice: <id>`. Before any greenfield
  command run `verify-task.cjs mode --for <start|plan|next>`: exit 6 means the project is not greenfield (existing code, archived
  changes, or already implemented); print its text and stop, write nothing. Never review your own specs: use `spec-reviewer`.
- **No commits.** Never commit, stage, stash, reset or switch branches: every change of a run stays uncommitted in the working tree for the user to review and commit.
- **Blocked means stop.** If something is wrong that you cannot fix inside the specs, write it to `BLOCKED.md` and stop; do not
  improvise around the specs.

### Per task: test-first, smallest change, verified

- `test-driven-development`: a failing test from `Test first:`, then minimal code.
- `ponytail` (full): name skipped extras, do not question the spec.
- `systematic-debugging` on an unexpected failure or after two failed fixes.
- `verification-before-completion`: run `Done when:` and read its output.
- A `Request code review` task: reviewer subagent (`requesting-code-review`), then `ponytail-review`. **Must fix** is Critical, **Should fix** Important; fix both before ticking.

`spec-implementer` has the detail.

### Apply loop (`/spec-apply <change>`): orchestrator, subagent, verifier

The main agent orchestrates; a script decides whether a task is done. A dispatch is the change at Size S, a task group at M/L, one task with `--per-task`. Per dispatch: `verify-task.cjs next <change> --format prompt`, ONE fresh
`spec-implementer` subagent does that dispatch only (none available: do it yourself), then `check <change> --reported <done|failed|blocked>`
(3 attempts per dispatch). `finish <change>` closes out. Exit 5 (visual review pending) and 10 (all done) are results, so never chain `check` with `&&`. Exit 5: ONE `spec-visual-reviewer` subagent, then `review <change> --reply <file>` (none available: `--reviewer none`); never
review your own screenshots. `/spec-apply` has the full loop and the other exit codes.

UI work: scenarios carry a ```` ```visual ```` block and tasks a `Visual:` line; run `verify-task.cjs visual <change>` before ticking.
A design to match: `/spec-explore` maps it to
project tokens and components first (`verify-task.cjs design-system`); a Figma URL uses `figma-to-code`. HTTPS dev servers with
self-signed certificates work (`visual.ignore_https_errors`, default on). Nothing is stored in the repository (no baselines).
A defect the change does not own (third-party widget, page chrome) may be skipped with `ignore:` / `ignore-http:` in the visual block or `visual.ignore` / `visual.ignore_http` in config (a11y:, runtime:, content:, horizontal overflow only; listed as "ignored (n)", never silent); never to pass your own defect.
A UI-facing proposal answers its `## UX checklist` (loading, empty, error, disabled, validation, recovery, keyboard, narrow, long-text): a scenario or `Not applicable: <reason>`.

### Traceability (`traceability: on|warn|off`)

Every requirement says `Why: <who wants it, and why>` on one line under its SHALL sentence. Rewriting the Why of an existing requirement, or removing a requirement, needs
`Owner approval: <name>, <date>` in the proposal, added only after the owner agreed. Put `@spec <capability>/<requirement-slug>` in one comment on the function that decides the requirement's behaviour, once per code path. Never on an import, constant,
type, string table or log line. Put it in the test that proves it too, or tag the test `[capability/scenario-slug]`. The verifier checks both.
`/spec-garden` fixes or accepts each drift gap. Where a marker goes: the `spec-implementer` agent.

Apply runs: pass `--session <id>` (one id per conversation) to every `verify-task.cjs` call. A run owned by another session or
worktree is refused (`run-owned`), and so is a command already running on the change (`busy`). Never start a second run. Use
`--takeover` only when the user says the other run is dead.

### Reference

`node openspec/scripts/verify-task.cjs help` prints every command, option, check rule, exit code, the run log and the config
keys. `verify-task.cjs doctor` shows what is missing in the config and environment. `lint <change>` checks tasks, size and visual
blocks. The schema's instructions and the `/spec-*` commands carry the detail for each stage.
<!-- WINGMAN-SPEC:END -->
