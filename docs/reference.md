# Wingman Spec reference

Wingman Spec plans a whole app with a **senior analyst** who writes specs for **junior developers**, then implements it
**test-first** with **fresh subagents**, each task checked by the `wingman-spec` CLI. It works in **Cursor, Claude Code and
Codex** from one source, and promotes **ADRs** to `adrs/` when a change is archived.

## Flow

```
explore (wingman-grilling) → app-map → proposal → specs → design → adrs → tasks → apply (TDD, subagents + CLI checks) → fix (QA) → archive (gate, merge specs + ADRs)
```

| Artifact | File | Purpose |
|----------|------|---------|
| `app-map` | `app-map.md` | Whole-app map: capability inventory, dependencies, build order (vertical slices), what this change covers |
| `proposal` | `proposal.md` | `Size:`, `Risk:`, why / what / capabilities / ADR candidates / impact / edge cases |
| `specs` | `specs/<capability>.md` | Concrete, testable delta specs (`## ADDED`, `## MODIFIED`, `## REMOVED`, `## RENAMED`); UI scenarios carry a ```` ```visual ```` block (route, key elements, states, viewports, design reference) |
| `design` | `design.md` | Decisions + implementation guide, pitfalls, testing approach for juniors |
| `adrs` | `adrs/*.md` | One ADR per significant decision (`adrs/none.md` with `status: none` if there is none) |
| `tasks` | `tasks.md` | Test-first checklist; each task has Spec / Test first / Files / Done when (UI tasks also `Visual:`, optional `After:`), plus review tasks |

`wingman-spec instructions <artifact> <change>` prints the instruction and template of each one; they are built into the CLI.

## Install into a project

Run **Wingman Spec: Set Up This Folder** in the editor ([docs/install.md](install.md)), or in the project:

```bash
.wingman-spec/bin/wingman-spec init --harness all      # Cursor + Claude Code + Codex (or e.g. --harness claude,codex)
```

`wingman-spec init` is idempotent. It writes:

- `.wingman-spec/wingman-spec.yaml`: an existing one is never overwritten. It detects the test, typecheck and lint commands (package scripts, `pytest`, `go test`, `cargo test`, `make test`, `tsc`, `eslint`, `ruff`, ...; a detected typecheck or lint command runs once and is left out when it fails) and the app command and URL for the visual check (Vite, Next.js). Whatever it cannot detect stays `<fill in>`, and `next` refuses to start until it is set (`doctor` lists it);
- `.wingman-spec/specs/`, `changes/`, `archive/` and `adrs/`, and `.wingman-spec/.gitignore` for `runs/`, `bin/`, `cache/` and `local/` (login sessions and local credentials, see Visual roles); your own `.gitignore` is not edited;
- the shim `.wingman-spec/bin/wingman-spec` (a symlink to the CLI, a `.cmd` on Windows), which the agents call;
- the `AGENTS.md` block (about 95 lines; `wingman-spec help reference` is the full reference), and per harness the skills, the `/spec-*` commands, the `spec-implementer`, `spec-visual-reviewer` and `spec-reviewer` subagents.

`wingman-spec update` rewrites the generated files after a CLI upgrade and leaves your settings and specs alone.

### Harnesses

The entry points and the subagents are **generated** from one source, `harness/` in this repository
(`commands/*.md`, `agents/*.md`, shared `partials/`), built into the CLI; never edit the generated copies.
See [docs/harness-support.md](harness-support.md) for the research behind the mapping.

| Harness | Commands | Subagent | Skills | Notes |
|---------|----------|----------|--------|-------|
| Cursor | `.agents/skills/spec-*/` (`/spec-apply`) | `.cursor/agents/spec-{implementer,visual-reviewer}.md` | `.agents/skills/` | shares `.agents/skills` with Codex |
| Claude Code | `.claude/commands/spec-*.md` (`/spec-apply`) | `.claude/agents/spec-{implementer,visual-reviewer}.md` | `.claude/skills/` | `CLAUDE.md` imports `AGENTS.md` |
| Codex | `.agents/skills/spec-*/` (`$spec-apply`) | `.codex/agents/spec-{implementer,visual-reviewer}.toml` | `.agents/skills/` | |

Cursor and Codex both read `.agents/skills/`, so the commands and bundled skills are written there once. Claude Code reads
neither `.agents/skills/` nor another tool's subagents, and the three subagent formats differ, so those stay per tool.
`.cursor/commands/` and `.cursor/skills/` from 0.12 are no longer written, and `update` leaves them as they are: delete
them by hand, or Cursor lists each command twice. `update` refreshes only the tools whose own folder (`.cursor/agents`, `.claude/commands`, `.codex/agents`) is present, and a
folder you delete is not offered back.

Wingman Spec registers no prompt hook, so OpenSpec's `/opsx:*` commands keep working next to it. Without subagent support the
orchestrator uses the **sequential fallback**: it does one dispatch per turn itself, and the same CLI checks it; the
visual review is then recorded as skipped.

### Layouts: next to the code, or a specs repository

| Your project | Layout | Install |
|--------------|--------|---------|
| **One git repo** | Next to the code (default): `.wingman-spec/` holds the settings, specs, changes, archive and ADRs | `wingman-spec init` |
| **Several git repos** (web, api, mobile, ...) | One **specs repository** for all specs, changes and ADRs (`wingman-spec.yaml` at its root); each code repo links to it with `specs: <path>` | `wingman-spec init --layout specs` in the specs repo, `wingman-spec init --layout link --specs ../specs` in each code repo |

`wingman-spec root --json` prints the code root and the specs root of the current folder. Folder layout, per-repo commands,
teammate setup and troubleshooting: [docs/workspace-layout.md](workspace-layout.md).

## CLI commands

Every command takes `--root <specs dir>` (or `WINGMAN_SPEC_ROOT`) and `--json`; `wingman-spec <command> --help` lists its options.

| Command | What it does |
|---------|--------------|
| `wingman-spec init`, `wingman-spec update` | Create the skeleton and install the agent files; refresh the generated files after an upgrade |
| `wingman-spec import openspec` | Convert a project of the OpenSpec-based 0.11 release (`openspec/`, `adr/`) to `.wingman-spec/` once (`--dry-run` lists the steps) |
| `wingman-spec root`, `wingman-spec config`, `wingman-spec doctor` | Where the specs live; the merged settings; what is missing in the settings and the environment |
| `wingman-spec new`, `wingman-spec list`, `wingman-spec status`, `wingman-spec instructions` | Create a change; list the active (or `--archived`) changes; which artifacts exist; the instruction and template of one artifact |
| `wingman-spec validate`, `wingman-spec lint`, `wingman-spec size`, `wingman-spec app-map` | Format and delta checks; the planning lint (`--text`: one `file:line: severity: text` line each; `--fix` inserts a missing `Why:`, the `## Purpose` of a new capability and the requirement `ID:` lines; `--format sarif\|markdown`); the declared size against the specs; the two-line app map of a Size S change |
| `wingman-spec trace`, `wingman-spec run-checks` | Scenarios without a tagged test and tags that name no scenario (`--format sarif\|markdown`); run the project's lint, typecheck, test and visual checks with logs in files and a parsed summary ([below](#checks-trace-and-the-archive-gate)) |
| `wingman-spec drift`, `wingman-spec problems` | Living-spec gaps vs code and tests; every located finding for editors (`--format json\|sarif\|markdown`; JSON includes `schema_version: 1`) |
| `wingman-spec next`, `wingman-spec check`, `wingman-spec review`, `wingman-spec finish`, `wingman-spec visual` | The apply loop (below); `finish --format junit\|markdown`; `finish --affected` runs only the tests of the requirements the change touches |
| `wingman-spec sync`, `wingman-spec archive`, `wingman-spec adrs` | Check (`--check`, with unified diffs of a pending merge) or re-pin (`--rebase`) a merge; gate, merge, promote the ADRs and archive a change (writes `trace.json`); list (or `--fix` renumber) the promoted ADRs |
| `wingman-spec anchors`, `wingman-spec guard` | Traceability (below); `drift` and `problems` are listed above |
| `wingman-spec log` | Record an agent step (`start`, `explore`, `grill`, `approval`, `note`) in the change's [timeline](timeline.md) |
| `wingman-spec design-system` | The project's tokens, UI library config and shared components, for design input |
| `wingman-spec mode`, `wingman-spec greenfield`, `wingman-spec roadmap`, `wingman-spec handover` | The new-product flow ([docs/greenfield.md](greenfield.md)) |
| `wingman-spec help reference` | Exit codes, every check, run state and configuration on one page |

## Using it

Commands, all prefixed `spec-` (Codex: `$spec-…`): `/spec-explore`, `/spec-propose`, `/spec-apply`, `/spec-fix`, `/spec-sync`, `/spec-archive`, `/spec-garden`, `/spec-green-start`, `/spec-green-plan` and `/spec-green-next` for a new product, and `/spec-adopt` for an existing codebase.

1. **Explore**: `/spec-explore [topic]` runs the `wingman-grilling` skill until every decision is settled. With a design input it maps the design to your tokens and components first (see [Design input](#design-input-matching-a-design)). It runs only commands that read and writes no file except that design map, so it also works in the agent's plan mode (Claude Code, Cursor or Codex). There the design map stays in the chat as well. It ends with the decisions and a proposal draft and offers `/spec-propose <slug>`, which picks them up from the chat (switch to agent mode first).
2. **Plan**: `/spec-propose <change>` writes every artifact in order and validates. `proposal.md` starts with `Size: S|M|L|XL|XXL` (checked against the specs by `wingman-spec size`). The task plan has at most 3 / 6 / 12 / 20 / 30 implementation tasks for S / M / L / XL / XXL, no close-out tasks, and a final code review only for Size M or larger, a Risk kind or a UI change (`wingman-spec lint` enforces it). XL and XXL are L with more tasks: the same artifacts and rules. A plan over its declared cap fails lint until the Size line is raised. Over 30 tasks lint only warns and suggests separate changes, each naming the change it depends on. A Size S change with `Risk: none`, no sensitive path (auth, payment, migrations, ...), no UI and no new dependency takes the fast path: only proposal, specs and tasks; an edit that leaves that scope upgrades the change to the full path (design, ADR record and app-map are then required). Reasons: [docs/fast-path.md](fast-path.md).
3. **Implement**: `/spec-apply <change>`. The main agent orchestrates; fresh `spec-implementer` subagents do the work. `wingman-spec next` hands out one dispatch (the change at Size S, a task group from Size M up) or a **wave** of up to `parallel:` (default 3) tasks of one group whose `Files:` do not overlap, one prompt each. `wingman-spec check` accepts a task only if exactly its box changed, its `Done when:` command, the project tests, typecheck, lint and `wingman-spec validate` pass, the changed tests do not read source files as text, and every scenario the task names has a test tagged `[capability/scenario-slug]`. In a wave each task is checked on its own (`--task`), and the project commands run at the wave's last check. A rejected task is retried with the failure output and the implementer's attempt note, up to 3 attempts. The note (`runs/<change>/notes/<task>.md`) says what the attempt tried and ruled out. Two attempts in a row can fail the same way: same check, first failing test and first error line. Then the next attempt is the last. `check` keeps the failed diff next to the note and puts the task's `Files:` back as they were at hand-out, and the prompt asks for a different approach. A repeat on the last attempt stops the task with that report. A reply without a `STATUS:` line is checked with `--reported none`. It stops when all boxes are ticked, on `BLOCKED.md`, or when a task runs out of attempts. UI tasks go through the visual loop inside the same check. A review task that changes code lists each fix as `Review fix: <slug> - <finding>` in `progress.md`. Its test carries `[review:<slug>]` in its name, or `review_<slug>` where test names are identifiers. `check` runs that test on the code as the review was handed out: it must fail there and pass now. `untestable: <reason>` on the line skips the test; it is warned about and kept in the timeline. How the test is selected is under [Review proof](#review-proof). After the last task `wingman-spec finish` runs the close-out without an agent (full tests, typecheck, lint, validate, every visual scenario, trace tags, source-text rule). Each step is logged in `runs/<change>/` of the specs root (git-ignored).
4. **Fix (optional)**: `/spec-fix [change] [findings]` after manual testing: classify each finding (code bug, wrong spec, new work), patch the open change or open a short follow-up, TDD what needs code.
5. **Archive**: `/spec-archive <change>` runs `wingman-spec archive <change>`. Its gate refuses (exit 1, every failed check listed, nothing written) a change with `BLOCKED.md`, open tasks, open findings, no passing `finish` on the current tree, a failing `lint`, or a delta that does not merge cleanly. Then it merges the delta specs ([strict merge](spec-merge.md)), promotes the ADRs to `adrs/NNNN-<slug>.md` (`supersedes:` marks the old one) and moves the change to `archive/YYYY-MM-DD-HHMM-<change>/` with its timeline and `archived.json` (`archived_at` to the second, with the UTC offset). There is no override flag.
6. **Sync (only on a refusal)**: `wingman-spec sync <change> --check` reports the merge without writing; `--rebase` re-pins the living text after another change moved it (update the delta first). `/spec-sync` covers both.
7. **Garden (any time)**: `/spec-garden` takes the drift report: each gap is fixed (code, test, marker or spec change) or, for a requirement gap, accepted.

**New product, no code yet?** Run `/spec-green-start` and keep running it: it reads `wingman-spec greenfield status` and does the one next step (inputs, questions, foundation, capabilities, review, roadmap, handover). Developers then use `/spec-green-next`. Each question, assumption and environment is its own file in `greenfield/records/`, so analysts working in parallel merge cleanly. See [docs/greenfield.md](greenfield.md).

**Existing codebase?** Run `/spec-adopt [scope]` once before the first change (`/spec-adopt src/billing` for one area, `--check` to only report). It agrees a capability inventory with you, writes baseline specs to `specs/<capability>.md` and records decisions already in the code as ADRs. It never overwrites an existing spec. Existing code is evidence of what happens today, not proof anyone wants it: only behavior a test, a document or the owner confirms becomes a requirement (each carries a `Confirmed:` line, and the spec's Purpose says `Baseline: adopted <date>`). Suspected bugs, debug leftovers, incidental details and unclear behavior go to `observed/<capability>.md`, one file per capability with an owner and how to confirm; `wingman-spec drift` lists adopted requirements without `Confirmed:` and incomplete entries (advisory). On the sample in `tests/fixtures/adopt` (7 seeded problems) the adopt command turns none into requirements and records all 7 (a regression fixture, not a benchmark).

**Rewrites keep your edits.** Anything a tool rewrites in a file that already exists (`init` and `update` on AGENTS.md, CLAUDE.md and workspace files; `adrs --fix`; `drift decide`; `greenfield approve`; the extension's marker fixes) changes only its own lines: comments, key order, blank lines, quoting and line endings stay byte for byte. `tests/fixers.sh` checks each one.

### Review proof

A review fix's test is named for the fix. Runners with free-text names take `[review:<slug>]`. Runners with identifier names take `review_<slug>`, with `_` for `-` (`TestReview_<slug>` in Go). ExUnit takes `@tag review: "<slug>"`. `check` runs each fix on its own, first on the code before the review and then on the fixed code. Both runs use the same command, so a filter that selects no test fails. The command comes from the first rule that applies:

1. `commands.test_one`, when it is set.
2. A name filter for the runner. The runner is found in the test command, the per-file command or the `package.json` test script. When none of these names one, a marker file decides and the runner's own command is used. The filters:

| Runner | Found by | Filter |
|---|---|---|
| Vitest, Jest, Bun | `vitest`, `jest`, `bun test` | `-t <regex>` |
| node:test | `node --test` | `--test-name-pattern=<regex>` |
| Mocha | `mocha` | `--grep <regex>` |
| Deno | `deno test` | `--filter /<regex>/` |
| Go | `go test`, `go.mod` | `-run <regex>` |
| pytest | `pytest`, `pytest.ini`, `conftest.py` | `-k review_<slug>` |
| Cargo | `cargo test`, `Cargo.toml` | `cargo test review_<slug>` |
| .NET | `dotnet test`, `*.sln`, `*.csproj`, `*.fsproj` | `--filter FullyQualifiedName~review_<slug>` |
| Maven | `mvn`, `mvnw`, `pom.xml` | `-Dtest=*#*review_<slug>*` |
| Gradle | `gradle`, `gradlew`, `build.gradle(.kts)` | `--tests *review_<slug>*` |
| RSpec | `rspec`, `.rspec` | `-e [review:<slug>]` |
| PHPUnit | `phpunit`, `phpunit.xml(.dist)` | `--filter <regex>` |
| Swift | `swift test`, `Package.swift` | `--filter <regex>` |
| ExUnit | `mix test`, `mix.exs` | `--only review:<slug>` |
| Dart, Flutter | `dart test`, `flutter test`, `pubspec.yaml` | `--name <regex>` |

`<regex>` matches both name forms. The filter goes before `{files}` or `{dirs}` of the per-file command, or after the test command.

3. The per-file command (`commands.targeted` or derived) on the tagged files.
4. The whole test command.

The `review_proof` check and the `review-proof` timeline event record the mode of each fix: `override`, `name:<runner>`, `file` or `suite`. Example override: `test_one: tox -e py -- -k {id} {file}`.

## Configuration (`.wingman-spec/wingman-spec.yaml`)

Unknown keys are errors, so a typo never becomes a silent default. Lookup order per key: flag or env, then the code repository's file, then the specs root's file.

| Key | Meaning | Default |
|---|---|---|
| `context` | free text for the planner (stack, conventions, domain words), printed with each artifact's instruction | `<fill in>` |
| `language` | the project's language and framework, for the planner | |
| `rules` | extra rules per artifact (`rules: {proposal: [...], tasks: [...]}`), printed with its instruction | none |
| `commands.test`, `commands.typecheck`, `commands.lint` | what `check` and `finish` run (`none` disables one) | detected by `init` |
| `commands.targeted` | how to run some test files (`{files}`, `{dirs}`); derived for common runners | derived |
| `commands.test_one` | how to run the tests of one review fix: `{name}` (a quoted regex for the tag and the identifier), `{id}` (`review_<slug>`), `{tag}`, `{file}` / `{files}`, `{dirs}` (env `WINGMAN_SPEC_TEST_ONE_CMD`) | by runner |
| `commands.check_level` | `targeted` / `group` / `task` / `finish`: when the project commands run during apply (env `WINGMAN_SPEC_CHECK_LEVEL`) | `targeted` |
| `commands.test_run` | `finish`: the project tests run once, at `finish` (env `WINGMAN_SPEC_TEST_RUN`) | |
| `parallel` | tasks per parallel wave (`1`: no waves; `next --parallel N` overrides) | `3` |
| `traceability` | `on` / `warn` / `off`: the `Why:` line, `@spec` anchors and drift (env `WINGMAN_SPEC_TRACEABILITY`) | `on` |
| `anchor_placement` | `warn` / `error` / `off`: where `@spec` markers sit (env `WINGMAN_SPEC_ANCHOR_PLACEMENT`) | `warn` |
| `anchor_fit` | `warn` / `error` / `off`: too many anchors on a requirement, anchors on imports, constants, types, string tables, getters or logging, in another capability's files, or on code with no word of the requirement (env `WINGMAN_SPEC_ANCHOR_FIT`) | `warn` |
| `anchor_max` | code anchors per requirement above which `anchor_fit` looks at the count: it reports it (once) only when some anchors are weak; anchors that each fit are never flagged for the count (`anchor_many: [cap/slug]` or `Anchors: many` in the requirement skips it) | `6` |
| `anchor_guard` | `warn` / `error` / `off`: anchored code changed without its requirement being mentioned, and the related checks (env `WINGMAN_SPEC_ANCHOR_GUARD`) | `warn` |
| `test_evidence` | `warn` / `strict` / `off`: `finish` checks that the tagged tests show up passing in the test output (env `WINGMAN_SPEC_TEST_EVIDENCE`) | `warn` |
| `anchor_stale` | `info` / `warn` / `error` / `off`: `drift` lists units changed after their requirement's text (env `WINGMAN_SPEC_ANCHOR_STALE`) | `info` |
| `visual.command`, `visual.url` | how to start the app and where it answers (`visual: off` turns the check off) | detected |
| `visual.port`, `visual.reuse_server` | the port the app listens on; `true`: use an app that is already running there instead of starting one | from `url`; `false` |
| `visual.ui_files` | file extensions that count as UI (a task touching one gets the visual check) | `tsx`, `jsx`, `vue`, `svelte`, `css`, `html`, ... |
| `visual.ready_timeout` | seconds to wait for `url` | 120 |
| `visual.contexts` | scenarios captured side by side in one browser (1-16) | 4 |
| `visual.review` | `off` or `subagent`: an independent subagent compares before/after clips | `off` |
| `visual.screenshots` | `affected` (clips of the task's areas, used only with the review) or `off` | `affected` |
| `visual.require_playwright` | `true`: a missing Playwright/Chromium fails the check instead of skipping it | `false` |
| `visual.page_timeout` | seconds a page load or a step may take | 5 |
| `visual.request_timeout` | seconds after which a subresource that has not answered is aborted and reported as a failed request (`0`: wait up to `page_timeout`) | 3 |
| `visual.baseline` | `on`: a request, console or axe defect outside the key elements that the capture before the task already had is listed once as info and does not fail the task | `off` |
| `visual.scope` | `task`: a task's check opens its own scenarios. The change's other scenarios and the other specs' scenarios run once at `finish`, against HEAD. `all`: every check opens them too, so a regression is found at the task that caused it | `task` |
| `visual.changed_only` | a passing visual run is not repeated while the app files (tree without tests and Markdown), scenarios, limits and pre-task capture are unchanged. A run with defects is never stored. Not used when the images go to the visual review or a scenario has a `role:` (a login depends on credentials and env vars). `off` turns it off | `on` |
| `visual.ignore_https_errors` | accept self-signed certificates in the probe and the browser | `true` |
| `visual.ignore` | defect codes every scenario skips (`a11y:` prefix, `a11y:color-contrast`, `runtime:console-error`, `content:broken-image`, `layout:horizontal-overflow`); listed in the report, never silent | none |
| `visual.ignore_http` | texts: failed requests, HTTP errors, console errors and broken images whose message contains one are skipped | none |
| `visual.browsers_path` | where Chromium is, if not in `PLAYWRIGHT_BROWSERS_PATH` or the default cache | |
| `visual.roles` | logins for gated features, see [Visual roles](#visual-roles-gated-features) | none |
| `specs`, `specs_remote` | a code repository linked to a specs repository: its relative path and git URL (`doctor` prints the clone line) | |
| `repos` | a specs repository: its code repositories (name and path relative to it); `mode` counts their code (as it does a sibling repo that links here), and adopt surveys them | |

| `test_files` | extra test-file globs for `trace`, `check` and `finish` (`**`, `*`, `?`; `!glob` drops files), on top of the built-in detection ([docs/test-files.md](test-files.md)) | none |
| `commands.junit` | a JUnit XML report the test command writes; `run-checks`, `check` and `finish` read it for the failure list | none |

Other overrides: `WINGMAN_SPEC_TEST_CMD` / `WINGMAN_SPEC_TYPECHECK_CMD` / `WINGMAN_SPEC_LINT_CMD`, `WINGMAN_SPEC_TIMEOUT_<NAME>`, `WINGMAN_SPEC_NO_CACHE`, `WINGMAN_SPEC_ROOT`. `wingman-spec config` prints the merged values and `wingman-spec doctor` what is missing.

The warm visual helper keeps Playwright loaded and one headless Chromium running after a visual run of `next`, `visual`, `check` or `finish`. The next run of the same code root then skips the node start, the Playwright load and the browser launch. Each run still starts the app server and opens every state in a fresh browser context, so the report is the same as without it. `ps` lists it as `wingman-visual-warm <code root>`. It serves one run at a time; a second one runs on its own. It stops after 300 s idle, within 10 s after the code root is gone (a run still going there then fails, and its app server and Chromium stop with it), within 10 s after wingman-spec is updated, and when Playwright is reinstalled. Another node or other `PLAYWRIGHT_*` settings get a helper of their own. At most two run per user, and the one used longest ago makes room. `WINGMAN_SPEC_VISUAL_WARM=off` turns it off and a number sets the idle seconds. Not on Windows.

## Traceability: the Why, anchors, drift

Set by `traceability:` in `.wingman-spec/wingman-spec.yaml`. A light layer on top of the specs.

Two links tie a requirement to the repository, and they answer different questions:

| | Trace: specs ↔ tests | Anchors: specs ↔ code |
|---|---|---|
| Question | Is each scenario proven by a test, and did that test pass? | Which code implements each requirement, and did it change without it? |
| Link | A test tagged `[capability/scenario-slug]` (or a `@spec` marker in a test) | A `@spec <capability>/<requirement-slug>` or `@spec <ID>` comment in code |
| Commands | `trace`, `finish` (records the results), `finish --affected` | `anchors`, `guard`, `anchors prune` |
| Reported by | `trace`, `drift` (`untested-requirement`, `stale-test-tag`, `failing-test`, `stale-test-result`) | `check`, `drift` (`unanchored-requirement`, `orphan-anchor`, `stale-anchor`, `over-anchored`) |

`finish` needs both for every requirement of the change: one code anchor, and one test anchor or tag (or a `Verify:` line).

- **Why.** Every requirement says `Why: <who wants it, and why>` on one line under its SHALL sentence, e.g. `Why: The account owner wants to reset a forgotten password, so that they are not locked out.` Name a role or a person; a purely technical requirement names the operator or maintainer who needs it. `lint` flags a requirement without a Why (`missing-why`) or with fewer than 5 words (`why-too-short`). The proposal's own `## Why` stays the reason for the change.
- **Owner approval.** Rewriting the Why of an existing requirement, or removing a requirement, changes what the owner asked for, so it needs `Owner approval: <name>, <date>` in the proposal (an audit line the agent writes after the owner agreed; the script cannot verify a person). Changing the SHALL text or scenarios with the same Why, or renaming a requirement, needs none. `lint` and `finish` check it by comparing the delta with the living spec, so it works until the change is synced; `/spec-sync` and `/spec-archive` run `lint` before the merge.
- **Anchors.** A comment `@spec <capability>/<requirement-slug>` in code and in tests. The markers are the index: nothing is stored, `wingman-spec anchors [--json]` computes it from `git ls-files`. `check` rejects markers that resolve to nothing; `finish` requires one code anchor and one test anchor (a marker or a `[capability/scenario-slug]` tag) per requirement of the change. Which files are tests, in which languages, and where the tag goes: [docs/test-files.md](test-files.md).
- **Requirement IDs.** A requirement may carry `ID: <CAPABILITY>-XXXX` (upper case; 4 random characters without 0, O, 1 or I), e.g. `ID: BILLING-7KQ3`. `lint --fix` gives each ADDED requirement a new one and puts the living ID back on MODIFIED and REMOVED entries. An ID never changes on a rename or a move to another capability, and is never reused: an archived REMOVED entry records it as retired. `lint` fails a lower-case ID (and prints the canonical form), a malformed one, one a MODIFIED entry changed or dropped, one another living requirement or active change holds, a retired one, and a new one whose prefix is not its capability folder. `drift` reports two living requirements with one ID (`duplicate-id`). `@spec` takes the ID or the slug, in any case: `@spec billing-7kq3` and `@spec Billing/Add-An-Item` both resolve. A marker by ID survives a rename. Requirements without an ID stay valid.
- **Renames.** A `## RENAMED` entry (`- Old name -> New name`) keeps the requirement and its ID. `next` rewrites the `@spec` markers of the old key in code and tests to the new key and prints each rewrite (`renamed: src/todo.js:4 @spec todo/remove-a-todo -> todo/delete-a-todo`; JSON `renamed_markers`). It only touches marker lines and a second run rewrites nothing. Test tags stay, since a rename keeps the scenarios.
- **Verify.** A requirement that no test can prove says how it is checked: `Verify: inspection|analysis|demonstration [note]` under its SHALL sentence. Its scenarios count as verified without a test in `trace`, and `drift` does not call it untested. Any other method is a lint error.
- **Test results.** `finish` records what its test run showed for each scenario (passed, failed, skipped) in `.wingman-spec/cache/test-results.json` (derived, git-ignored), with the commit, the tree and fingerprints of the requirement text and of the code under its markers. `anchors --json`, `drift` and `problems` read it back per requirement: passed, failed, skipped, not run, or stale because the spec or the code changed since. `drift` lists `failing-test` and `stale-test-result` as advisory gaps (they never fail it) with a `tests:` count line; the extension's Requirements view shows "2 tests passed", "failed" or "stale". `finish --affected` records only the requirements it ran.
- **Overlap.** `lint` warns at the delta line when another active change also adds, modifies, removes or renames the same requirement (`overlap`): the change archived later overwrites the other.
- **Marker placement.** A requirement implemented by a whole function, method or class gets its marker once in the doc comment. One implemented by a few lines gets one marker on its own line directly above them. Flagged: `trailing-marker` (end of a code line), `duplicate-marker`, `file-top-marker`, `detached-marker`. The check is line-based (no parser), so it can be wrong on unusual layouts: that is why `anchor_placement` defaults to `warn`.
- **Apply-run state.** A run records who started it (`--session <id>` or `WINGMAN_SPEC_SESSION`, worktree, branch, HEAD, tree hash, start) and each passing check stores the commit and the hash of the task's files. `next`, `check`, `review` and `finish` take a per-change lock (heartbeat, so a dead process never blocks) and refuse a run another session or worktree started less than 30 idle minutes ago (`run-owned`; `--takeover` adopts it). A ticked task whose record came from a branch that is not in this history, with different files, is `unverified-ticks` again. When everything is verified, `next`/`finish` print one status line: which run, which commit, whether the tree still matches. Separate git worktrees keep separate run logs.
- **Anchor fit.** Too many markers say as little as none. The anchor fit check is a heuristic (`anchor_fit`, default `warn`). It reports:
  - more than `anchor_max` (6) code anchors on one requirement, when some are weak. The finding names the weak ones once; anchors that each fit are never flagged for the count. Above 12, one info line asks whether to split the requirement. `Anchors: many` or `anchor_many` skips this.
  - an anchor on boilerplate: an import, a constant, a type, a string/i18n table, a getter or setter, a log line;
  - more than 3 requirements in one small unit;
  - an anchor in another capability's file: a `Files` path of a task about another capability, or that capability's folder;
  - an anchor on code that shares no word with the requirement.

  `drift` lists them as `over-anchored`, and the editor shows them with a quick action. `wingman-spec anchors prune [--apply] [--select file:line,...]` removes just those marker lines, never code and never a requirement's last anchor; the anchor guard accepts that removal. What it cannot know: whether a unit with a plausible name really implements the behaviour. A wiring line that registers a route can be the right anchor and is not flagged.
- **Drift.** `wingman-spec drift [--text]` reports requirements without a code or test anchor, anchors on removed requirements, tests tagged to missing scenarios and changes archived without sync. `drift decide <gap-key> --accept --note ...` accepts a requirement gap (unanchored, untested, stale-anchor) by writing one `Accepted: <why>` line on the requirement in its spec, like `Confirmed:`; `--all <gap-type>` does it for every open gap of a type (one line per requirement). Gaps in code (orphan marker, stale test tag, misplaced marker, unsynced archive) cannot be accepted: fix them.
- **No commits.** Agents never commit, stage, stash or switch branches; the whole change stays in the working tree for you to review and commit. Why this is safe for the verifier: [docs/no-commits.md](no-commits.md).
- **Parallel PRs.** Derived data is never committed, living records are one file each, decisions are sharded per capability. What is stored where: [docs/parallel-prs.md](parallel-prs.md).
- **Anchor guard.** `wingman-spec guard <change> --base REF` (run by `check` and `finish` against the base the apply loop recorded) compares each anchored unit before and after: anchored code changed without its requirement in the change, a changed unit outside the task's `Files`, removed or moved markers, one marker on many units, a requirement whose text changed while its code did not. `test_evidence` checks the tagged tests appear passing in the test output. `drift` also lists `stale-anchor` (code changed after the requirement text) and `misplaced-marker`. `wingman-spec problems --json` lists all findings with file and line for editors.
- **Limits.** A marker proves someone claimed the code implements the requirement, not that it does. With a shared specs repository drift is computed per code repo against the shared specs: requirements implemented in another repo show as unanchored (decide them `accept`). The layer cannot see semantic contradictions or duplicate requirements.

### What is and is not guaranteed

| Guaranteed (the verifier rejects or reports it) | Not guaranteed |
|---|---|
| Every `@spec` marker resolves to a requirement; each requirement of a change has a code anchor and a test anchor or tag | That the marked code really implements the requirement |
| Marker placement (as a warning by default) | Placement and units are found line-based; unusual layouts can be wrong |
| Anchored code changed with no mention of its requirement, removed and moved markers, sprawl, a requirement changed with its code untouched, stale anchors (`guard`, `drift`) | That a changed unit with its requirement touched still satisfies it: the reviewer step and the tests decide |
| Tagged tests show up passing (`test_evidence`) | Evidence with a reporter that prints no test names |
| Unanchored, untested, orphan, stale-tag and unsynced-archive gaps (`drift`, `problems`) | Contradictory or duplicate requirements |
| Requirement IDs are unique, kept and never reused (`lint`, `drift`) | That two IDs do not name the same behaviour |
| The last recorded test result per requirement, and whether the spec or code changed since | That a test of unmarked code ran under `finish --affected` |

## Visual loop (UI work)

So that bad UI never reaches "done" and nobody has to keep asking the agent to fix it:

1. **Specs** (`/spec-propose`): every UI scenario gets a ```` ```visual ```` block: `route:`, `key:` selectors, optional
   `state:` lines with the steps to reach them (`do: click …`, `fill … = …`, `storage … = …`), `viewports:` (default 375, 768,
   1280; set per scenario, a state cannot narrow them), an optional `reference:` design image and `component:`. Tasks name the scenarios they complete in `Visual:`. A `click` or `hover` step depends on its target:

   | The step's target is… | `click` / `hover` | `click!` / `hover!` |
   |---|---|---|
   | visible and works | runs | runs |
   | present but hidden at this width (a menu toggle at 1280 px) | skipped, with an info note in the report | fails |
   | missing, covered, disabled or timed out | fails | fails |

   `fill`, `press`, `storage` and `goto` are never skipped.
   `wingman-spec lint` checks the blocks, the references and that every scenario is named by a task.
   A UI-facing proposal also has a `## UX checklist` (loading, empty, error, disabled, validation, recovery, keyboard, narrow, long-text): each item is a scenario or `Not applicable: <reason>`; `lint` warns about a missing answer ([docs/ux-completeness.md](ux-completeness.md)).
2. **Before** (`wingman-spec next`, for a task with `Visual:` or UI files in `Files:`): before the implementer touches
   anything, the verifier starts the app from `visual:` in `.wingman-spec/wingman-spec.yaml` and records the task's scenarios at each
   viewport. It records DOM/runtime defects, the ARIA snapshot (`locator.ariaSnapshot()`) of each key element, and clip
   screenshots of the box around the key elements. With `visual.scope: all` it also records the change's earlier scenarios
   and all of `specs/`. If `next` could not take it, `check` takes it from a temporary git worktree of HEAD.
3. **Deterministic check** (`wingman-spec check`): the same pass again, **screenshot-free**: console errors and uncaught
   exceptions, failed or ≥400 requests, axe WCAG 2.0 + 2.1 A/AA violations (tags wcag2a, wcag2aa, wcag21a, wcag21aa; e.g. a button whose accessible name hides its visible label), horizontal overflow, key elements that are missing, hidden
   (computed style), off-screen or overlapping (bounding boxes), broken images. For the task's scenarios every defect fails.
   Every other declared scenario is checked by `finish` (by each `check` with `visual.scope: all`), from `specs/` as it reads
   after archive. Archive's own merge applies the deltas, so a removed or dropped scenario is not run, and a delta that does
   not merge fails finish with the conflict named. A defect fails only if it is new, and so does a change of its ARIA snapshot unless its `component:` is in the task's `Files:`. That guards the
   unaffected areas with no stored baseline: nothing is committed, everything lives under `runs/<change>/<run>/visual/` (git-ignored). Each defect is one line (scenario,
   state, viewport, element, numbers, ARIA diff) in the retry prompt. No Playwright: the check is **skipped with a loud
   warning** (`visual.require_playwright: true` makes that a failure). **Certificate errors are ignored by default**: an
   https dev server with a self-signed certificate works, in the readiness probe and in the browser
   (`visual.ignore_https_errors: false` makes both strict).
4. **Review**: when the deterministic checks pass, `check` exits 5 and writes a review prompt with before -> after pairs of
   the task's area clips and their ARIA diff; the orchestrator dispatches the read-only `spec-visual-reviewer` subagent,
   which compares them with the scenario and the design reference and replies `DEFECT: …` lines plus `STATUS: pass|fail`.
   `wingman-spec review --reply <file>` turns a fail into a rejected attempt (same 3-attempt limit). The review is off by
   default (`visual.review: off`); turn it on (`subagent`) only where an independent reviewer subagent can run. Without one the
   review is recorded as skipped (`--reviewer none`); the implementer never reviews its own screenshots. `/spec-fix` uses the
   same loop.
5. **Implementer self-check**: the task prompt tells the implementer to run `wingman-spec visual <change>` (defects,
   ARIA changes, before/after area images) before ticking.

What this cannot catch without pixels: a purely visual change outside the task's scope that leaves geometry, visibility,
contrast and the accessibility tree intact (a colour, font, shadow or icon swap in an unrelated screen). Inside the
task's areas the reviewer sees before/after images.

### Skipping defects that are not yours (`ignore`)

A page can carry defects the change does not own: a third-party widget with a contrast problem, an image served by another team that 404s, a console error from an analytics script. Skip them where they are declared, not in the code under test:

````visual
route: /gallery
key: [data-testid="photo-grid"]
ignore: a11y:color-contrast     # one axe rule; `ignore: a11y:` skips every axe rule (a code ending in ":" is a prefix)
ignore: runtime:console-error   # exact code
ignore-http: /static/images/    # failed requests, HTTP errors, console errors and broken images whose message contains this text
````

`visual.ignore` (codes) and `visual.ignore_http` (texts) in `.wingman-spec/wingman-spec.yaml` do the same for every scenario (a list, or comma-separated; a code repo's own `visual:` replaces the specs repository's list per key). Rules:

- Skipped defects are **not failures but never silent**: the check output and `report.json` carry `ignored (n)` and one line per `code - scenario (rule that skipped it)`.
- Only these classes can be skipped: `a11y:` (and one rule, `a11y:<axe-id>`), `runtime:console-error`, `runtime:page-error`, `runtime:request-failed`, `runtime:http-error` (or the prefix `runtime:`), `content:broken-image` (or `content:`), and `layout:horizontal-overflow`. The defects that are the scenario's own claim cannot be skipped and are refused with an error: `layout:key-*` (a key element missing, hidden or off-screen), `layout:overlap`, `design:*` (`expect:`), `role:*` (`absent:`, `redirects-to:`, login), `state:*`, `server:*`, `regression:*`.
- Refused as unsafe: an empty value, a bare `:`, spaces, commas or wildcards in a code, an unknown code, a prefix other than `a11y:`, `runtime:`, `content:`, and an `ignore-http` text shorter than 3 characters or only a scheme or slashes (it would match almost everything). `ignore` and `ignore-http` belong to the whole block, not to a `state:`.
- `ignore-http` matches the message after the scenario prefix (the request URL is in it). A console error of a failed load (`Failed to load resource: the server responded with a status of 404 ()`, a 403, a 500 or a `net::ERR_*`) has no URL in its text. It is matched by the URL the browser reports for it. If the browser gives none, it is skipped when the page already skipped a failed request with the same status or `net::` error. A failed load whose URL is known and matches no pattern is always reported. The ignored list says which pattern skipped each console error.
- An implementer must not add an `ignore` to make a defect in the code it just wrote go away; this is for what the change does not own, and a reviewer sees it in the report.

### Visual roles (gated features)

A visual block with `role: admin` runs logged in as that role, so a page only an admin sees is checked as an admin. Roles are defined once under `visual.roles` in `.wingman-spec/wingman-spec.yaml`; a block names one role (or none: not logged in) and may add `absent:` (selector that must not be visible to that role) and `redirects-to:` (the route must end on that path).

````yaml
visual:
  roles:
    admin:
      login: /login            # form login; user and password come from WINGMAN_ROLE_ADMIN_USER / _PASSWORD
      success: /dashboard      # optional: path or selector that proves the login worked
    editor:
      storage_state: .wingman-spec/local/auth/editor.json   # a Playwright session you recorded (SSO, MFA, captcha)
    sso-user:
      login_command: node scripts/sso-login.js    # your script writes the session to $WINGMAN_ROLE_STATE_FILE
    api-client:
      headers_env: Authorization=API_TOKEN        # header name = env var that holds the value
````

````visual
route: /dashboard
role: viewer
key: [data-testid="welcome"]
absent: [data-testid="admin-link"]     # the viewer must not see the admin link
````

- **Credentials are never committed.** Passwords come from the env vars (names configurable per role with `user_env:` / `password_env:`) or from `.wingman-spec/local/roles.yaml` (`admin:` then indented `user:` and `password:`). A `password:` key in `wingman-spec.yaml` is rejected. `.wingman-spec/local/` is gitignored, so nothing in it is committed; `doctor` fails if something in it is tracked by git.
- **Sessions** from a login are saved to `.wingman-spec/local/auth/<role>.json` (mode 600, never committed) and reused by every scenario of the run. Passwords are never printed or put in reports; a failed login names the role and the page's own error message, and leaves a screenshot in the system temp dir (not in the repository).
- `doctor` lists each role and what it still lacks (env var names, never values). `lint` rejects an undefined role, two roles in one block, and a step that types into a password field.
- **Limits.** The form login finds the fields with common selectors (override with `user_field:`, `password_field:`, `submit:`); logins with MFA, SSO or captcha need `storage_state:` or `login_command:`. Sessions are cookies and local storage; they are not refreshed during a run. Tested here against a local app with a login form, a recorded session, a script login and header auth, not against a real identity provider.

## Design input (matching a design)

When the input includes a design (an image, a prototype, a Figma/Sketch export or a screenshot), the result must match
it: the same layout, hierarchy, spacing, colours, typography and components, though not pixel-perfect.

1. **Explore maps the design to the code before any planning.** `wingman-spec design-system` lists the project's
   tokens (CSS custom properties, Tailwind `@theme`/config, `tokens.json`), UI library theme config and shared components
   with their variants. Every region and element of the design is mapped in this order of preference: a project
   **token**, then an existing **component** and variant, then a **framework** default (only where the project defines
   nothing), and an **arbitrary** value only as a last resort, which is always listed under Gaps. The map goes to
   `explore-design/<slug>.md` in the specs root, and `/spec-propose` moves it into the change as `design-map.md`.
2. **Every map row carries checkable facts** (`Expect`), and text elements always carry font-size, font-weight and
   line-height. These become `expect:` lines in the scenario's visual block:
   `expect: <selector> <property> ~|=|!= <value|token:name> [@viewport]`, plus relations (`left-with`, `before`,
   `above`, `same-row`, `same-height`, `gap-to`). Colours compare by colour distance and lengths within about 8%.
   Block-level expects describe the loaded page; another state's facts go under that `state:`.
3. **Lint** fails a map row with no matching `expect:` in the specs, a text row without typography, and an arbitrary
   value equal to an existing token.
4. **The visual check** measures every `expect:` from computed styles and geometry at each viewport, without
   screenshots, and a mismatch rejects the task with the numbers.

## Checks, trace and the archive gate

- `wingman-spec lint <change> --text` prints every plan problem as `file:line: severity: text`, exit 1 on an error. Besides the format, size and visual rules it checks that every requirement has a scenario, task IDs are unique, every task has `Files:` and `After:` names an earlier task. The `Files:` rule follows `traceability`: a warning with `warn`, dropped with `off`. It reports two tasks of one group that change the same file, since a wave only holds tasks with disjoint `Files:`. It also checks that a visual scenario is reachable from the design (`visual-reach`). A route whose selectors show a list, table, grid, feed or cart needs a populated `state:` such as `one-row`, `many-rows`, `long-name` or `each-status` (`visual-data-states`, error). The state has its own steps or keys, or a role or route names the data, and it runs at 375 when the route is checked there. `Not visual` on a narrow, long-text or many-rows scenario is an error (`not-visual-layout`). `ignore: layout:horizontal-overflow` in a scenario whose THEN says nothing scrolls sideways is a warning (`visual-overflow-claim`). A surviving `specs/` scenario on the same route, query and role that requires on load (`key:`/`expect:`, or a state that only waits, hovers or closes an overlay) a selector this change declares `absent:` (or a narrowing of it, `input.qty` covers `input.qty[disabled]`) is an error (`visual-stale-guard`). So is one with the same WHEN, in the same capability, as a change scenario whose THEN says the case is omitted or no longer shown (`visual-dropped-scenario`). Both name the living requirement to put under `## REMOVED` or `## MODIFIED`.
- `wingman-spec trace [<change>] [--text]` lists the scenarios (of the change's delta specs, or of the living specs) that no test tags with `[capability/scenario-slug]`, and the tags of a known capability that name no scenario. Test files are the built-in detection plus `test_files`. Exit 1 on any finding.
- `wingman-spec run-checks [<change>] [--only lint,typecheck,test,visual] [--text]` runs the configured commands (uncached; visual only for a change, headless) and writes each log to `runs/<change>/checks/` (`runs/checks/` without a change). The summary lists the failures it parsed (TAP, JUnit XML, node --test, vitest, jest, pytest, go test, eslint, tsc; else the exit code and the log's tail) and the log path. With a change it adds a `checks` event to the timeline. Exit 1 when one fails.
- `wingman-spec progress <change> [--task <id>] --note "<text>"` appends one entry to the change's `progress.md`, under the task's heading, and records a `progress` timeline event. `--status done|partial|blocked` marks a note; `--review-fix <slug>` (with a review `--task`, optional `--untestable "<reason>"`) writes the `Review fix:` line the review proof reads, and recording a slug again replaces its line; `--reviewed-anchor <cap>/<req>` writes the `Reviewed anchors:` line the anchor guard reads. Agents never edit `progress.md` by hand.
- `wingman-spec finish <change> --affected` runs, through the targeted-test template, only the tests of the requirements the change touches: its ADDED, MODIFIED and renamed requirements, and those whose anchored code units changed since the change began. Their tests are the files tagged with their scenarios or carrying their markers, plus changed test files and tests named after changed sources. The tests check lists the files and requirements. It follows markers: a test of changed code that carries no marker or tag of an affected requirement is not run, so use plain `finish` when markers are sparse. Without a targeted template, or with no affected test file, it runs the full suite and says why. A passing `--affected` run does not satisfy the archive gate.
- `wingman-spec archive <change>` is the only archive path. Its gate (`blocked`, `tasks`, `findings`, `finish`, `lint`, `merge`) runs before anything is written. `finish` passes only when the last passing finish recorded the same working tree (code, tests and the change folder; the living specs, ADRs and archive do not count); a `Kind: spec-only` change skips it, and outside git it is skipped with a note.
- `drift` reports archived changes whose requirements are missing from the living specs (`unsynced-archive`), so an archive made by hand is found afterwards.
- The merge is strict: every ambiguous case is refused with the file and line, and the result is computed in memory, checked and written atomically ([docs/spec-merge.md](spec-merge.md)).
- `wingman-spec sync --check <change>` and `drift` are deterministic (exit 1 when not synced or drifting) and can run in CI or a git hook.

## Bundled skills

In `skills/`, first-party copies rewritten for the apply loop are installed as `wingman-*` so they do not collide with a user's own upstream copy. Origins and MIT credit are in `skills/NOTICE.md`. The copies are `wingman-test-driven-development`, `wingman-systematic-debugging`, `wingman-requesting-code-review`, `wingman-verification-before-completion`, `wingman-grilling`, `wingman-ponytail` and `wingman-ponytail-review`. `wingman-ponytail` is the write-time rule the implementer follows on every task (it ends with the task). `wingman-ponytail-review` is the report format of the review task. `figma-to-code` (see the next section) and `spec-writing` are original: the writing rules for proposals, specs and tasks. The artifact instructions and `/spec-propose` load `spec-writing` while they write.

## Building or updating the site from a Figma design

Give `/spec-explore` (or `/spec-propose`) a Figma link and say what you want; the `figma-to-code` skill is loaded by the
design-map step. Works the same in Cursor, Claude Code and Codex.

```text
/spec-explore build the pricing section from https://www.figma.com/design/AbC123/Plans?node-id=12-345
/spec-explore update the account overview to match https://www.figma.com/design/AbC123/Plans?node-id=7-88
```

- **BUILD**: the node does not exist in the code. The skill reads the node, maps every value to your project's design
  tokens first, then your existing components and variants, then framework defaults (arbitrary values only as flagged
  gaps), writes `explore-design/<slug>.md` (the normal design map, with `Expect` facts from the Figma numbers)
  and asks the designer's questions. `/spec-propose` and `/spec-apply` then run unchanged: `wingman-spec lint` and the
  `visual` `expect:` checks enforce the map.
- **UPDATE**: the node exists in the code. The skill adds a table "Figma value vs the code today" per element and
  property; only the rows that differ become tasks, and everything else stays as it is.
- A link with no `node-id` is refused (it would fetch the whole file): copy the link of the frame (right-click, *Copy
  link to selection*). `design/`, `file/`, `proto/`, branch links and `1-2`/`1:2` ids are understood.
- **Sources, in order**: (1) the Figma MCP server when it is connected, (2) the Figma REST API with a `FIGMA_TOKEN`,
  through a dependency-free Node script shipped with the skill (needs only Node, written for 18+ and tested on 22), (3) exported PNG/SVG per
  breakpoint or a pasted screenshot, where every number is listed as an estimate. The token is only read from the
  environment, sent only to Figma and never printed or written to a file.

Set up one of these (the CLI itself needs none of them):

| Harness | Figma MCP (richest: variables, Code Connect) | REST token |
|---|---|---|
| Claude Code | `claude plugin install figma@claude-plugins-official`, or `claude mcp add --transport http figma https://mcp.figma.com/mcp` (add `--scope user` for all projects), then `/mcp`, figma, Authenticate | `export FIGMA_TOKEN=...` before starting `claude` |
| Codex | `codex mcp add figma --url https://mcp.figma.com/mcp` | `export FIGMA_TOKEN=...` before starting `codex` |
| Cursor | `/add-plugin figma`, or `.cursor/mcp.json` `{"mcpServers":{"figma":{"url":"https://mcp.figma.com/mcp"}}}` then Settings, Tools & MCP, Connect | start Cursor from a shell that has `FIGMA_TOKEN` |

(VS Code: `.vscode/mcp.json` `{"inputs":[],"servers":{"figma":{"url":"https://mcp.figma.com/mcp","type":"http"}}}`.)
A REST token: Figma, Settings, Security, Personal access tokens, scope `file_content:read`. The MCP server needs a Dev or
Full seat (Professional: 200 calls/day, 10/minute; View/Collab seats and Starter plans: 20 calls a month); REST reads
variable *names* only on Enterprise plans (otherwise the skill matches by value and name and flags it). Limits as read
on 2026-10-24 and may change; details: `skills/figma-to-code/references/figma-sources.md`.
Never commit the token or paste it into chat.

The skill's script is tested offline (`tests/figma-to-code.sh`: URL parser, normaliser, token mapping, diff, CLI
errors against a local stub server, no token leakage); it has **not** been run against live Figma by the package
authors (no account or token was available), so try it on one small frame first.

## VS Code extension

`vscode-extension/` is the **Wingman Spec** extension for VS Code and Cursor; it bundles the CLI. Pages, commands and
settings: [vscode-extension/README.md](../vscode-extension/README.md).

## Develop / test

Requires Go (see `go.mod`) and Node 22. The shell suites run against the binary in `WINGMAN_SPEC_BIN` (`go build -o /tmp/wingman-spec ./cmd/wingman-spec`). Visual tests need Playwright and axe-core: set `PLAYWRIGHT_NODE_MODULES` to a `node_modules` that has both. `go test ./...` covers the packages.

| Suite | Covers |
|---|---|
| `tests/smoke.sh` | `init --harness all` (settings, shim, AGENTS block, commands, subagents, skills, no hook files), `update` idempotency, and one Size S change from `new` to `archive` and `drift` |
| `tests/parallel-waves.sh` | parallel waves: lanes, `check --task`, file ownership, the wave's last check reopening a lane or the wave |
| `tests/fastpath.sh`, `tests/runcache.sh` | the fast path and its upgrade; the result cache |
| `tests/visual-steps.sh` | state steps: `click` / `hover` on a control hidden at one viewport is skipped with an info note (clicked where visible), a missing or covered control and the strict `click!` fail, `fill` is never skipped |
| `tests/verify-task.sh` | the apply-loop contract with stub subagents, injected faults, quality checks and the visual loop against static pages |
| `tests/retry-notes.sh` | retries: the failure fingerprint (timings and positions ignored), the start-over on a repeat and the stop on the last attempt, the attempt note in the retry prompt and its removal on pass, `--reported none` |
| `tests/review-proof.sh` | the review proof: a review that changes code needs a `Review fix:` line per fix and a `[review:<slug>]` test that fails on the code before the review and passes after (each fix on its own), or `untestable: <reason>` (warned and in the timeline); selection by name, by `commands.test_one`, per file and by whole suite, with real runs for node:test, and Go and pytest when installed |
| `tests/chronology.sh` | archived.json written by the archive step, same-day ordering, the legacy fallbacks, created time, replay order |
| `tests/traceability.sh` | the Why line, owner approval, anchors, drift, sync and archive gates |
| `tests/testpaths.sh` | which paths are tests (positive and negative table), one tagged test per language through `finish`, `anchors`, `problems` and the anchor guard, PHP and Java gaps |
| `tests/parallel.sh` | two branches changing the same project: what merges cleanly and what is detected |
| `tests/visual-ignore.sh` | `ignore:` and `ignore-http:` (exact, prefix, repeatable, console errors of 403/404/500 loads matched by URL or by the same skipped failure), `visual.ignore` / `visual.ignore_http` in config, the ignored list in the report, unsafe values refused, key / absent / expect / overlap failures never skippable, the `next`/`check` path (needs Playwright + axe-core) |
| `tests/next-perf.sh` | `next` and `check` on a large repo (20,000 tracked files, ignored `node_modules`, an untracked 190 MB docker data directory): under 3 s and 6 s, nothing written into `.git`, the real index untouched, an edit of a tracked or untracked file changes the hash, the data is not counted as changed lines |
| `tests/runfreq.sh` | how often tests, typecheck, lint and `Done when` run in a 5-task change, counted: one task or one group per dispatch, `check_level` targeted (default), group, task and finish (also set in `wingman-spec.yaml`), a fault at an early task caught at the first check or at `finish`, a review task always running everything |
| `tests/targeted.sh` | the default check level: which test files a check runs (changed, tagged with the task's scenarios, named after its files), the per-file command template from the test command or `commands.targeted`, the note when none is known, a fault in a targeted test caught at the check and one in any other test caught at `finish`, `group` and `task` as opt-ins |
| `tests/timeline.sh` | the timeline of a change: a fake run writes its events in order, a plan edited mid-build becomes one decision entry with what changed, the reason and the owner approval state, parallel appends lose no line, `archive` keeps the timeline |
| `tests/visual-cache.sh` | `visual.changed_only` (a pass is not repeated; test and Markdown edits do not matter, a changed page does; a failing run is never stored; `WINGMAN_SPEC_NO_CACHE`), `visual.scope` (default `task`: own scenario per task, the other spec's scenario at `finish`; `all`: every scenario per task) and the warm helper (the next run is served by it with the same report; `WINGMAN_SPEC_VISUAL_WARM=off`; a stopped helper) |
| `tests/visual-noisy.sh` | a page with requests that never answer, console errors, axe defects and overflow: waited for once, the load failure keeps the other checks, runtime defects once per viewport, `visual.page_timeout` / `request_timeout`, `visual.baseline` (old defects listed once, new ones fail) (needs Playwright + axe-core) |
| `tests/apply-runs.sh` | run ownership (two sessions, `--takeover`, idle adoption), the lock (live, dead, stale heartbeat), what a record stores (run, session, HEAD, tree and files hash), records from another branch, the `status`/`run_status` lines, worktree and split-layout isolation |
| `tests/anchorguard.sh` | changed, moved and removed anchors, sprawl, `Files` scope, test evidence, stale-anchor and misplaced-marker drift, false-positive controls |
| `tests/anchorfit.sh` | over-anchoring: the login-on-an-i18n-line fixture, every lint (count, boilerplate, crowded unit, foreign capability, no shared words), `anchors prune` (never the last anchor, `--select`), `anchor_fit` levels, the anchor guard on a removed marker |
| `tests/problems.sh` | `problems --json`: shape, locations and severities of every finding source, and the fix hints |
| `tests/roles.sh` | visual roles against a local app with a login (form, session, command, headers; no secret leaks) |
| `tests/design-contract.sh` | design-system discovery, design map lint, `expect:` checks |
| `tests/figma-to-code.sh` | the Figma skill's script, offline |
| `tests/greenfield.sh` | new-product mode guard, status, roadmap, handover, reviews, scripted walker (stub content) |
| `tests/adopt.sh` | `/spec-adopt` observed-unconfirmed: verifier checks and the scored before/after sample |
| `tests/fixers.sh` | every fixer and generator leaves everything outside its own lines byte-identical |
| `tests/prose-lint.sh` | the prose lint (`scripts/prose-lint.cjs`): each rule, `--strict`, what it skips, `--metrics`, the vague-THEN info in `wingman-spec lint`, no shipped sentence above 60 words |
| `tests/drift.sh` | docs, options, skills and generated files stay in step; the `spec-writing` skill loaded where specs are written and passing its own rules |
