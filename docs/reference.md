# Wingman Spec reference

A custom [OpenSpec](https://github.com/Fission-AI/OpenSpec) schema for planning a whole app with a
**senior analyst** who writes specs for **junior developers**, then implementing it **test-first**
with **one fresh subagent per task**, each checked by a deterministic verifier script. It works in
**Cursor, Claude Code and Codex** from one source. It also publishes **ADRs** to `adr/` next to `openspec/` when specs are synced.

## Flow

```
explore (grilling) → app-map → proposal → specs → design → adrs → tasks → apply (TDD, subagent per task + verifier) → fix (QA) → sync (specs + ADRs) → archive
```

| Artifact | File | Purpose |
|----------|------|---------|
| `app-map` | `app-map.md` | Whole-app map: capability inventory, dependencies, build order (vertical slices), what this change covers |
| `proposal` | `proposal.md` | Why / what / capabilities / ADR candidates / impact |
| `specs` | `specs/**/*.md` | Concrete, testable delta specs; UI scenarios carry a ```` ```visual ```` block (route, key elements, states, viewports, design reference) |
| `design` | `design.md` | Decisions + implementation guide, pitfalls, testing approach for juniors |
| `adrs` | `adrs/*.md` | One ADR per significant decision (`adrs/none.md` with `status: none` if there is none) |
| `tasks` | `tasks.md` | Test-first checklist; each task has Spec / Test first / Files / Done when (UI tasks also `Visual:`), plus review tasks |

## Install into a project

```bash
./install.sh /path/to/project                    # Cursor (default)
./install.sh /path/to/project --harness all      # Cursor + Claude Code + Codex (or e.g. --harness claude,codex)
cd /path/to/project && openspec schema validate wingman-spec
```

This is the single-repo layout. **Several git repos in one workspace: use an OpenSpec store**, see [Two layouts](#two-layouts-one-repo-or-a-workspace-with-several-repos).

The installer is idempotent. It writes:

- the schema (`openspec/schemas/wingman-spec/`) and the verifier scripts in `openspec/scripts/` (`verify-task.cjs`, `visual-check.cjs`, `quality.cjs`, `design-contract.cjs`, `traceability.cjs`, `placement.cjs`, `testpaths.cjs`, `anchorguard.cjs`, `anchorfit.cjs`, `chronology.cjs`, `runstate.cjs`, `problems.cjs`, `roles.cjs`, `greenfield.cjs`);
- `openspec/config.yaml` (an existing one is never overwritten: a `.suggested` file is written instead). It detects the test, typecheck and lint commands (package scripts, `pytest`, `go test`, `cargo test`, `make test`, `tsc`, `eslint`, `ruff`, ...; each is run once, and written as `none` with the reason if it is not installed or already fails) and the app command and URL for the visual check (Vite, Next.js). Whatever it cannot detect stays `<fill in>`, and `verify-task.cjs` refuses to apply until it is set (`doctor` lists it);
- the `AGENTS.md` block (about 90 lines; `verify-task.cjs help` is the full reference), and per harness the skills, the `/spec-*` commands, the `spec-implementer` and `spec-visual-reviewer` subagents and the prompt guard hook;
- `openspec/.local/`, a folder that ignores itself (login sessions and local credentials, see Visual roles); your `.gitignore` is not edited.

### Harnesses

The entry points and the subagent are **generated** from one source, `project-template/harness/`
(`commands/*.md`, `agents/spec-implementer.md`, shared `partials/`), by `scripts/render-harness.sh`; never edit the
generated copies. See [docs/harness-support.md](harness-support.md) for the research behind the mapping.

| Harness | Commands | Subagent | Skills | Guard hook |
|---------|----------|----------|--------|------------|
| Cursor | `.cursor/commands/spec-*.md` (`/spec-apply`) | `.cursor/agents/spec-{implementer,visual-reviewer}.md` | `.cursor/skills/` | `.cursor/hooks.json` `beforeSubmitPrompt` |
| Claude Code | `.claude/commands/spec-*.md` (`/spec-apply`) | `.claude/agents/spec-{implementer,visual-reviewer}.md` | `.claude/skills/` | `.claude/settings.json` `UserPromptSubmit`; `CLAUDE.md` imports `AGENTS.md` |
| Codex | `.agents/skills/spec-*/` (`$spec-apply`) | `.codex/agents/spec-{implementer,visual-reviewer}.toml` | `.agents/skills/` | `.codex/hooks.json` `UserPromptSubmit` (after you trust it in `/hooks`) |

Without subagent support the orchestrator uses the **sequential fallback**: it does one task per turn itself (and
reviews the before/after images itself with the same rubric), and the same verifier checks it.

### Two layouts: one repo, or a workspace with several repos

The **OpenSpec root** is the directory that contains `openspec/` (config, schema, `specs/`, `changes/`) and the
promoted `adr/`. Pick the layout by how many git repositories the project has:

| Your project | Layout | Install |
|--------------|--------|---------|
| **One git repo** | Next to code (default): that repo is both the code repo and the root | `./install.sh <repo>` |
| **A workspace with several git repos** (web, api, mobile, ...) | **Registered OpenSpec store** (use this): one store repo for all specs, changes and ADRs; every code repo points at it | `./install.sh <repo> --store <id>`, once per code repo |
| Specs in a separate repo, without the registry | `--specs <specs-repo>`: the same idea; the code repo links by relative path (`openspec/workspace.yaml`) | `./install.sh <repo> --specs <specs-repo>` |

**Several git repos: use `--store`.** Do not install the schema into each repo separately (their specs and changes would
be split), and do not make one of the code repos the root (the others could not share it).

Folder layout, per-repo commands, step-by-step install, teammate setup and troubleshooting: [docs/workspace-layout.md](workspace-layout.md). The installer is run from the unpacked schema folder and is not copied into the projects.

## Using it

Commands, all prefixed `spec-` (Codex: `$spec-…`): `/spec-explore`, `/spec-propose`, `/spec-apply`, `/spec-fix`, `/spec-sync`, `/spec-archive`, `/spec-garden`, and `/spec-green-start` and `/spec-green-next` for a new product, and `/spec-adopt` for an existing codebase.

1. **Explore**: `/spec-explore [topic]` runs the `grilling` skill until every decision is settled. With a design input it maps the design to your tokens and components first (see [Design input](#design-input-matching-a-design)).
2. **Plan**: `/spec-propose <change>` writes every artifact in order and validates. `proposal.md` starts with `Size: S|M|L` (checked against the specs by `verify-task.cjs size`); the task plan has at most 3 / 5 / 8 implementation tasks, no close-out tasks, and a final code review only for Size M/L, a Risk kind or a UI change (`verify-task.cjs lint` enforces it). A Size S change with `Risk: none`, no sensitive path (auth, payment, migrations, ...), no UI and no new dependency takes the fast path: only proposal, specs and tasks; an edit that leaves that scope upgrades the change to the full path (design, ADR record and app-map are then required). Reasons: [docs/fast-path.md](fast-path.md).
3. **Implement**: `/spec-apply <change>`. The main agent orchestrates, one fresh `spec-implementer` subagent does each task. `verify-task.cjs next` picks the task and writes its prompt; `verify-task.cjs check` accepts it only if exactly that box was ticked, its `Done when:` command, the project tests, typecheck, lint and `openspec validate --strict` pass, the changed tests do not read source files as text, and every scenario the task names has a test tagged `[capability/scenario-slug]`. A rejected tick is reverted and retried with the failure output, up to 3 attempts. It stops when all boxes are ticked, on `BLOCKED.md`, or when a task runs out of attempts. UI tasks go through the visual loop inside the same check. After the last task `verify-task.cjs finish` runs the close-out without an agent (full tests, typecheck, lint, validate, every visual scenario, trace tags, source-text rule). Each check is logged in `openspec/.apply-runs/` (git-ignored).
4. **Fix (optional)**: `/spec-fix [change] [findings]` after manual testing: classify each finding (code bug, wrong spec, new work), patch the open change or open a short follow-up, TDD what needs code.
5. **Sync**: `/spec-sync <change>` merges the delta specs, promotes the ADRs to `adr/NNNN-<slug>.md` (re-runs update in place; `supersedes:` marks the old one), then runs `verify-task.cjs sync` (read-only anchor and drift check). `--check` reports without writing; `--adrs-only` skips the spec merge. `/spec-archive` runs it first, so run it on its own only to inspect or fix a sync problem.
6. **Archive**: `/spec-archive <change>` runs `/spec-sync`, then `verify-task.cjs archive <change>`, which refuses (exit 1, with the reasons) a change whose specs are not merged, ADRs not promoted or drift open, and only then moves it to `openspec/changes/archive/`, where it also writes `archived.json` (`archived_at` to the second, with the UTC offset, and `created_at` when known). The archive folder name carries only the day, so the file is what orders archives, History and the activity lists by time; a folder without it falls back to the git commit time that added it, then the folder's modification time, then the date in its name (no migration; old folders are never rewritten).
7. **Garden (any time)**: `/spec-garden` takes the drift report: each gap is fixed (code, test, marker or spec change) or, for a requirement gap, accepted.

**New product, no code yet?** Run `/spec-green-start` and keep running it: it reads `verify-task.cjs greenfield status` and does the one next step (inputs, questions, foundation, capabilities, review, roadmap, handover). Developers then use `/spec-green-next`. Each question, assumption and environment is its own file in `openspec/greenfield/records/`, so analysts working in parallel merge cleanly. See [docs/greenfield.md](greenfield.md).

**Existing codebase?** Run `/spec-adopt [scope]` once before the first change (`/spec-adopt src/billing` for one area, `--check` to only report). It agrees a capability inventory with you, writes baseline specs to `openspec/specs/<capability>/spec.md` and records decisions already in the code as ADRs. It never overwrites an existing spec. Existing code is evidence of what happens today, not proof anyone wants it: only behavior a test, a document or the owner confirms becomes a requirement (each carries a `Confirmed:` line, and the spec's Purpose says `Baseline: adopted <date>`). Suspected bugs, debug leftovers, incidental details and unclear behavior go to `openspec/observed/<capability>.md`, one file per capability with an owner and how to confirm; `verify-task.cjs drift` lists adopted requirements without `Confirmed:` and incomplete entries (advisory). On the sample in `tests/fixtures/adopt` (7 seeded problems) the old adopt turned 2 into requirements and kept none in the repository; the new one turns none into requirements and records all 7 (one agent made both runs, so this is a regression fixture, not a benchmark).

**Rewrites keep your edits.** Anything a tool rewrites in a file that already exists (`install.sh` on AGENTS.md, config, hook and workspace files; `adrs --fix`; `drift decide`; `greenfield approve`; the extension's marker fixes and ADR promotion) changes only its own lines: comments, key order, blank lines, quoting and line endings stay byte for byte. A JSON hook file in an unusual layout is left untouched with a "register by hand" message. `tests/fixers.sh` checks each one.

## Configuration (`openspec/config.yaml`)

| Key | Meaning | Default |
|---|---|---|
| `schema` | always `wingman-spec` | |
| `context`, `rules` | text injected into the artifact instructions; the `Test/Typecheck/Lint command:` lines in `context` are what `verify-task.cjs` runs (`none` disables one) | detected by the installer |
| `traceability` | `on` / `warn` / `off`: the `Why:` line, `@spec` anchors and drift (env `SPEC_TRACEABILITY` overrides) | `on` for new installs, `off` when the key is absent |
| `anchor_placement` | `warn` / `error` / `off`: where `@spec` markers sit (env `SPEC_ANCHOR_PLACEMENT`) | `warn` |
| `anchor_fit` | `warn` / `error` / `off`: too many anchors on a requirement, anchors on imports, constants, types, string tables, getters or logging, in another capability's files, or on code with no word of the requirement (env `SPEC_ANCHOR_FIT`) | `warn` |
| `anchor_max` | code anchors per requirement above which `anchor_fit` looks at the count: it reports it (once) only when some anchors are weak; anchors that each fit are never flagged for the count (`anchor_many: [cap/slug]` or `Anchors: many` in the requirement skips it) | `6` |
| `anchor_guard` | `warn` / `error` / `off`: anchored code changed without its requirement being mentioned, and the related checks (env `SPEC_ANCHOR_GUARD`) | `warn` |
| `test_evidence` | `warn` / `strict` / `off`: `finish` checks that the tagged tests show up passing in the test output (env `SPEC_TEST_EVIDENCE`) | `warn` |
| `anchor_stale` | `info` / `warn` / `error` / `off`: `drift` lists units changed after their requirement's text (env `SPEC_ANCHOR_STALE`) | `info` |
| `visual.command`, `visual.url` | how to start the app and where it answers (`visual: off` turns the check off) | detected |
| `visual.ready_timeout` | seconds to wait for `url` | 120 |
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
| `store`, `store_remote`, `specs` | where the OpenSpec root is (workspace layouts, above) | |

Other overrides: `SPEC_TEST_CMD` / `SPEC_TYPECHECK_CMD` / `SPEC_LINT_CMD`, `SPEC_VISUAL_PLAYWRIGHT`, `OPENSPEC_ROOT`. `verify-task.cjs doctor` prints the effective values and the file each came from.

## Traceability: the Why, anchors, drift

Set by `traceability:` in `openspec/config.yaml`. A light layer on top of the specs.

- **Why.** Every requirement says `Why: <who wants it, and why>` on one line under its SHALL sentence, e.g. `Why: The account owner wants to reset a forgotten password, so that they are not locked out.` Name a role or a person; a purely technical requirement names the operator or maintainer who needs it. `lint` flags a requirement without a Why (`missing-why`) or with fewer than 5 words (`why-too-short`). The proposal's own `## Why` stays the reason for the change.
- **Owner approval.** Rewriting the Why of an existing requirement, or removing a requirement, changes what the owner asked for, so it needs `Owner approval: <name>, <date>` in the proposal (an audit line the agent writes after the owner agreed; the script cannot verify a person). Changing the SHALL text or scenarios with the same Why, or renaming a requirement, needs none. `lint` and `finish` check it by comparing the delta with the living spec, so it works until the change is synced; `/spec-sync` runs `lint` before it merges.
- **Anchors.** A comment `@spec <capability>/<requirement-slug>` in code and in tests. The markers are the index: nothing is stored, `verify-task.cjs anchors [--json]` computes it from `git ls-files`. `check` rejects markers that resolve to nothing; `finish` requires one code anchor and one test anchor (a marker or a `[capability/scenario-slug]` tag) per requirement of the change. Which files are tests, in which languages, and where the tag goes: [docs/test-files.md](test-files.md).
- **Marker placement.** A requirement implemented by a whole function, method or class gets its marker once in the doc comment. One implemented by a few lines gets one marker on its own line directly above them. Flagged: `trailing-marker` (end of a code line), `duplicate-marker`, `file-top-marker`, `detached-marker`. The check is line-based (`placement.cjs`, no parser), so it can be wrong on unusual layouts: that is why `anchor_placement` defaults to `warn`.
- **Apply-run state.** A run records who started it (`--session <id>` or `SPEC_SESSION`, worktree, branch, HEAD, tree hash, start) and each passing check stores the commit and the hash of the task's files. `next`, `check`, `review` and `finish` take a per-change lock (heartbeat, so a dead process never blocks) and refuse a run another session or worktree started less than 30 idle minutes ago (`run-owned`; `--takeover` adopts it). A ticked task whose record came from a branch that is not in this history, with different files, is `unverified-ticks` again. When everything is verified, `next`/`finish` print one status line: which run, which commit, whether the tree still matches. Separate git worktrees keep separate run logs.
- **Anchor fit.** Too many markers say as little as none. `anchorfit.cjs` is a heuristic (`anchor_fit`, default `warn`). It reports:
  - more than `anchor_max` (6) code anchors on one requirement, when some are weak. The finding names the weak ones once; anchors that each fit are never flagged for the count. Above 12, one info line asks whether to split the requirement. `Anchors: many` or `anchor_many` skips this.
  - an anchor on boilerplate: an import, a constant, a type, a string/i18n table, a getter or setter, a log line;
  - more than 3 requirements in one small unit;
  - an anchor in another capability's file: a `Files` path of a task about another capability, or that capability's folder;
  - an anchor on code that shares no word with the requirement.

  `drift` lists them as `over-anchored`, and the editor shows them with a quick action. `verify-task.cjs anchors prune [--apply] [--select file:line,...]` removes just those marker lines, never code and never a requirement's last anchor; the anchor guard accepts that removal. What it cannot know: whether a unit with a plausible name really implements the behaviour. A wiring line that registers a route can be the right anchor and is not flagged.
- **Drift.** `verify-task.cjs drift [--text]` reports requirements without a code or test anchor, anchors on removed requirements, tests tagged to missing scenarios and changes archived without sync. `drift decide <gap-key> --accept --note ...` accepts a requirement gap (unanchored, untested, stale-anchor) by writing one `Accepted: <why>` line on the requirement in its spec, like `Confirmed:`; `--all <gap-type>` does it for every open gap of a type (one line per requirement). Gaps in code (orphan marker, stale test tag, misplaced marker, unsynced archive) cannot be accepted: fix them.
- **No commits.** Agents never commit, stage, stash or switch branches; the whole change stays in the working tree for you to review and commit. Why this is safe for the verifier: [docs/no-commits.md](no-commits.md).
- **Parallel PRs.** Derived data is never committed, living records are one file each, decisions are sharded per capability. What is stored where: [docs/parallel-prs.md](parallel-prs.md).
- **Anchor guard.** `verify-task.cjs guard <change> --base REF` (run by `check` and `finish` against the base the apply loop recorded) compares each anchored unit before and after: anchored code changed without its requirement in the change, a changed unit outside the task's `Files`, removed or moved markers, one marker on many units, a requirement whose text changed while its code did not. `test_evidence` checks the tagged tests appear passing in the test output. `drift` also lists `stale-anchor` (code changed after the requirement text) and `misplaced-marker`. `verify-task.cjs problems --json` lists all findings with file and line for editors.
- **Limits.** A marker proves someone claimed the code implements the requirement, not that it does. In the store layout drift is computed per code repo against the shared specs: requirements implemented in another repo show as unanchored (decide them `accept`). The layer cannot see semantic contradictions or duplicate requirements.

### What is and is not guaranteed

| Guaranteed (the verifier rejects or reports it) | Not guaranteed |
|---|---|
| Every `@spec` marker resolves to a requirement; each requirement of a change has a code anchor and a test anchor or tag | That the marked code really implements the requirement |
| Marker placement (as a warning by default) | Placement and units are found line-based; unusual layouts can be wrong |
| Anchored code changed with no mention of its requirement, removed and moved markers, sprawl, a requirement changed with its code untouched, stale anchors (`guard`, `drift`) | That a changed unit with its requirement touched still satisfies it: the reviewer step and the tests decide |
| Tagged tests show up passing (`test_evidence`) | Evidence with a reporter that prints no test names |
| Unanchored, untested, orphan, stale-tag and unsynced-archive gaps (`drift`, `problems`) | Contradictory or duplicate requirements |

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
   `verify-task.cjs lint` checks the blocks, the references and that every scenario is named by a task.
   A UI-facing proposal also has a `## UX checklist` (loading, empty, error, disabled, validation, recovery, keyboard, narrow, long-text): each item is a scenario or `Not applicable: <reason>`; `lint` warns about a missing answer ([docs/ux-completeness.md](ux-completeness.md)).
2. **Before** (`verify-task.cjs next`, for a task with `Visual:` or UI files in `Files:`): before the implementer touches
   anything, the verifier starts the app from `visual:` in `openspec/config.yaml` and records the task's scenarios at each
   viewport. It records DOM/runtime defects, the ARIA snapshot (`locator.ariaSnapshot()`) of each key element, and clip
   screenshots of the box around the key elements. With `visual.scope: all` it also records the change's earlier scenarios
   and all of `openspec/specs/`. If `next` could not take it, `check` takes it from a temporary git worktree of HEAD.
3. **Deterministic check** (`verify-task.cjs check`): the same pass again, **screenshot-free**: console errors and uncaught
   exceptions, failed or ≥400 requests, axe WCAG 2.0 + 2.1 A/AA violations (tags wcag2a, wcag2aa, wcag21a, wcag21aa; e.g. a button whose accessible name hides its visible label), horizontal overflow, key elements that are missing, hidden
   (computed style), off-screen or overlapping (bounding boxes), broken images. For the task's scenarios every defect fails.
   Every other declared scenario is checked by `finish` (by each `check` with `visual.scope: all`): a defect fails only if it
   is new, and so does a change of its ARIA snapshot unless its `component:` is in the task's `Files:`. That guards the
   unaffected areas with no stored baseline: nothing is committed, everything lives under `openspec/.apply-runs/<change>/<run>/visual/` (git-ignored). Each defect is one line (scenario,
   state, viewport, element, numbers, ARIA diff) in the retry prompt. No Playwright: the check is **skipped with a loud
   warning** (`visual.require_playwright: true` makes that a failure). **Certificate errors are ignored by default**: an
   https dev server with a self-signed certificate works, in the readiness probe and in the browser
   (`visual.ignore_https_errors: false` makes both strict).
4. **Review**: when the deterministic checks pass, `check` exits 5 and writes a review prompt with before -> after pairs of
   the task's area clips and their ARIA diff; the orchestrator dispatches the read-only `spec-visual-reviewer` subagent,
   which compares them with the scenario and the design reference and replies `DEFECT: …` lines plus `STATUS: pass|fail`.
   `verify-task.cjs review --reply <file>` turns a fail into a rejected attempt (same 3-attempt limit). The review is off by
   default (`visual.review: off`); turn it on (`subagent`) only where an independent reviewer subagent can run. Without one the
   review is recorded as skipped (`--reviewer none`); the implementer never reviews its own screenshots. `/spec-fix` uses the
   same loop.
5. **Implementer self-check**: the task prompt tells the implementer to run `verify-task.cjs visual <change>` (defects,
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

`visual.ignore` (codes) and `visual.ignore_http` (texts) in `openspec/config.yaml` do the same for every scenario (a list, or comma-separated; a repo's own `visual:` replaces the store's list per key). Rules:

- Skipped defects are **not failures but never silent**: the check output and `report.json` carry `ignored (n)` and one line per `code - scenario (rule that skipped it)`.
- Only these classes can be skipped: `a11y:` (and one rule, `a11y:<axe-id>`), `runtime:console-error`, `runtime:page-error`, `runtime:request-failed`, `runtime:http-error` (or the prefix `runtime:`), `content:broken-image` (or `content:`), and `layout:horizontal-overflow`. The defects that are the scenario's own claim cannot be skipped and are refused with an error: `layout:key-*` (a key element missing, hidden or off-screen), `layout:overlap`, `design:*` (`expect:`), `role:*` (`absent:`, `redirects-to:`, login), `state:*`, `server:*`, `regression:*`.
- Refused as unsafe: an empty value, a bare `:`, spaces, commas or wildcards in a code, an unknown code, a prefix other than `a11y:`, `runtime:`, `content:`, and an `ignore-http` text shorter than 3 characters or only a scheme or slashes (it would match almost everything). `ignore` and `ignore-http` belong to the whole block, not to a `state:`.
- `ignore-http` matches the message after the scenario prefix (the request URL is in it). A console error of a failed load (`Failed to load resource: the server responded with a status of 404 ()`, a 403, a 500 or a `net::ERR_*`) has no URL in its text. It is matched by the URL the browser reports for it. If the browser gives none, it is skipped when the page already skipped a failed request with the same status or `net::` error. A failed load whose URL is known and matches no pattern is always reported. The ignored list says which pattern skipped each console error.
- An implementer must not add an `ignore` to make a defect in the code it just wrote go away; this is for what the change does not own, and a reviewer sees it in the report.

### Visual roles (gated features)

A visual block with `role: admin` runs logged in as that role, so a page only an admin sees is checked as an admin. Roles are defined once under `visual.roles` in `openspec/config.yaml`; a block names one role (or none: not logged in) and may add `absent:` (selector that must not be visible to that role) and `redirects-to:` (the route must end on that path).

````yaml
visual:
  roles:
    admin:
      login: /login            # form login; user and password come from WINGMAN_ROLE_ADMIN_USER / _PASSWORD
      success: /dashboard      # optional: path or selector that proves the login worked
    editor:
      storage_state: openspec/.local/auth/editor.json   # a Playwright session you recorded (SSO, MFA, captcha)
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

- **Credentials are never committed.** Passwords come from the env vars (names configurable per role with `user_env:` / `password_env:`) or from `openspec/.local/roles.yaml` (`admin:` then indented `user:` and `password:`). A `password:` key in `config.yaml` is rejected. `openspec/.local/` holds its own `.gitignore` (`*`), so nothing in it is committed; `doctor` fails if something in it is tracked by git.
- **Sessions** from a login are saved to `openspec/.local/auth/<role>.json` (mode 600, never committed) and reused by every scenario of the run. Passwords are never printed or put in reports; a failed login names the role and the page's own error message, and leaves a screenshot in the system temp dir (not in the repository).
- `doctor` lists each role and what it still lacks (env var names, never values). `lint` rejects an undefined role, two roles in one block, and a step that types into a password field.
- **Limits.** The form login finds the fields with common selectors (override with `user_field:`, `password_field:`, `submit:`); logins with MFA, SSO or captcha need `storage_state:` or `login_command:`. Sessions are cookies and local storage; they are not refreshed during a run. Tested here against a local app with a login form, a recorded session, a script login and header auth, not against a real identity provider.

## Design input (matching a design)

When the input includes a design (an image, a prototype, a Figma/Sketch export or a screenshot), the result must match
it: the same layout, hierarchy, spacing, colours, typography and components, though not pixel-perfect.

1. **Explore maps the design to the code before any planning.** `verify-task.cjs design-system` lists the project's
   tokens (CSS custom properties, Tailwind `@theme`/config, `tokens.json`), UI library theme config and shared components
   with their variants. Every region and element of the design is mapped in this order of preference: a project
   **token**, then an existing **component** and variant, then a **framework** default (only where the project defines
   nothing), and an **arbitrary** value only as a last resort, which is always listed under Gaps. The map goes to
   `openspec/explore-design/<slug>.md`, and `/spec-propose` moves it into the change as `design-map.md`.
2. **Every map row carries checkable facts** (`Expect`), and text elements always carry font-size, font-weight and
   line-height. These become `expect:` lines in the scenario's visual block:
   `expect: <selector> <property> ~|=|!= <value|token:name> [@viewport]`, plus relations (`left-with`, `before`,
   `above`, `same-row`, `same-height`, `gap-to`). Colours compare by colour distance and lengths within about 8%.
   Block-level expects describe the loaded page; another state's facts go under that `state:`.
3. **Lint** fails a map row with no matching `expect:` in the specs, a text row without typography, and an arbitrary
   value equal to an existing token.
4. **The visual check** measures every `expect:` from computed styles and geometry at each viewport, without
   screenshots, and a mismatch rejects the task with the numbers.

## Sync is enforced by the script, not by OpenSpec

OpenSpec's sync cannot be extended by a schema, and `openspec archive` can merge specs on its own, so "also promote ADRs" cannot be enforced inside OpenSpec. So:

- `/spec-archive` always runs `/spec-sync` first, then `verify-task.cjs archive <change>`, the only archive path the commands use. It checks that the specs are merged (block text equal), the ADRs are promoted and current and no drift is open, and refuses with exit 1 otherwise.
- `drift` reports archived changes whose requirements are missing from the living specs (`unsynced-archive`), so an archive that skipped the script is found afterwards.
- Not stopped: a bare `openspec archive <change>` typed in a shell (the prompt hook blocks only `/opsx:archive` prompts). `verify-task.cjs sync-check <change>` and `drift` are deterministic (exit 1 when not synced or drifting) and can run in CI or a git hook.

## Bundled skills

In `skills/`, pinned to upstream commits (`skills/VENDORED.md`; refresh with `scripts/vendor-skills.sh --update`, check with `--verify`): `test-driven-development`, `systematic-debugging`, `requesting-code-review`, `verification-before-completion` ([obra/superpowers](https://github.com/obra/superpowers)), `grilling` ([mattpocock/skills](https://github.com/mattpocock/skills)), `ponytail` and `ponytail-review` ([DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)). Both ponytail skills stay: `ponytail` is the short write-time rule set the implementer follows on every task, `ponytail-review` the long, read-only report format of the one review task. Two skills are first party: `figma-to-code` (see the next section) and `spec-writing`, the writing rules for proposals, specs and tasks with one before/after example. The schema and `/spec-propose` load `spec-writing` while they write.

## Building or updating the site from a Figma design

Give `/spec-explore` (or `/spec-propose`) a Figma link and say what you want; the `figma-to-code` skill is loaded by the
design-map step. Works the same in Cursor, Claude Code and Codex.

```text
/spec-explore build the pricing section from https://www.figma.com/design/AbC123/Plans?node-id=12-345
/spec-explore update the account overview to match https://www.figma.com/design/AbC123/Plans?node-id=7-88
```

- **BUILD**: the node does not exist in the code. The skill reads the node, maps every value to your project's design
  tokens first, then your existing components and variants, then framework defaults (arbitrary values only as flagged
  gaps), writes `openspec/explore-design/<slug>.md` (the normal design map, with `Expect` facts from the Figma numbers)
  and asks the designer's questions. `/spec-propose` and `/spec-apply` then run unchanged: `verify-task.cjs lint` and the
  `visual` `expect:` checks enforce the map.
- **UPDATE**: the node exists in the code. The skill adds a table "Figma value vs the code today" per element and
  property; only the rows that differ become tasks, and everything else stays as it is.
- A link with no `node-id` is refused (it would fetch the whole file): copy the link of the frame (right-click, *Copy
  link to selection*). `design/`, `file/`, `proto/`, branch links and `1-2`/`1:2` ids are understood.
- **Sources, in order**: (1) the Figma MCP server when it is connected, (2) the Figma REST API with a `FIGMA_TOKEN`,
  through a dependency-free Node script shipped with the skill (needs only Node, written for 18+ and tested on 22), (3) exported PNG/SVG per
  breakpoint or a pasted screenshot, where every number is listed as an estimate. The token is only read from the
  environment, sent only to Figma and never printed or written to a file.

Set up one of these (nothing is needed to install the schema):

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

`vscode-extension/` is **Wingman Spec**, a sidebar for Cursor and VS Code (`elmo-egers.wingman-spec`). It lists each active change with its artifact pipeline, test-first tasks, `BLOCKED.md`, the sync state of each ADR, and an Overview page (delivery board, ADR count, blockers). For traceability it adds an Explorer tree (capabilities, requirements with their Why, anchors, flags, drift gaps) and, in any file, CodeLens, hover, go-to-definition and warnings for `@spec` markers, including placement findings (setting `wingmanSpec.codeView`). It adds a branch review page (the git branch against its base), a change dashboard with what blocks the archive, and a Problems panel fed by `verify-task.cjs problems --json`; the verifier and git are only called read-only. See [vscode-extension/README.md](../vscode-extension/README.md); build a `.vsix` with `pnpm run package` inside that folder.

## Develop / test

Requires `node` and `openspec` on PATH. Visual tests need Playwright and axe-core: set `PLAYWRIGHT_NODE_MODULES` to a `node_modules` that has both.

| Suite | Covers |
|---|---|
| `tests/smoke.sh` | installer for all harnesses, idempotency, the store layout with three repos, the verifier with injected failures, deterministic harness rendering (`SMOKE_NETWORK=1` also verifies the vendored skills upstream) |
| `tests/visual-steps.sh` | state steps: `click` / `hover` on a control hidden at one viewport is skipped with an info note (clicked where visible), a missing or covered control and the strict `click!` fail, `fill` is never skipped |
| `tests/task-lines.sh` | `verify-task` finds a task's checkbox when `openspec instructions apply --json` has no `line` / `sourcePath` (OpenSpec 1.7.x: a shim strips them from the real output; duplicate descriptions, regex characters, several task files, a task that matches nothing is refused, the recorded 1.7.0 output) |
| `tests/verify-task.sh` | the apply-loop contract with stub subagents, injected faults, quality checks and the visual loop against static pages |
| `tests/chronology.sh` | archived.json written by the archive step, same-day ordering, the legacy fallbacks, created time, replay order |
| `tests/traceability.sh` | the Why line, owner approval, anchors, drift, sync and archive gates |
| `tests/placement.sh` | `@spec` marker placement on good and bad fixtures (ts, js, py, go, java, vue, php) |
| `tests/testpaths.sh` | which paths are tests (positive and negative table), one tagged test per language through `finish`, `anchors`, `problems` and the anchor guard, PHP and Java gaps |
| `tests/parallel.sh` | two branches changing the same project: what merges cleanly and what is detected |
| `tests/visual-ignore.sh` | `ignore:` and `ignore-http:` (exact, prefix, repeatable, console errors of 403/404/500 loads matched by URL or by the same skipped failure), `visual.ignore` / `visual.ignore_http` in config, the ignored list in the report, unsafe values refused, key / absent / expect / overlap failures never skippable, the `next`/`check` path (needs Playwright + axe-core) |
| `tests/next-perf.sh` | `next` and `check` on a large repo (20,000 tracked files, ignored `node_modules`, an untracked 190 MB docker data directory): under 3 s and 6 s, nothing written into `.git`, the real index untouched, an edit of a tracked or untracked file changes the hash, the data is not counted as changed lines |
| `tests/runfreq.sh` | how often tests, typecheck, lint and `Done when` run in a 5-task change, counted: one task or one group per dispatch, `Check level` targeted (default), group, task and finish (also set in `config.yaml`), a fault at an early task caught at the first check or at `finish`, a review task always running everything |
| `tests/targeted.sh` | the default check level: which test files a check runs (changed, tagged with the task's scenarios, named after its files), the per-file command template from the test command or `- Targeted test command:`, the note when none is known, a fault in a targeted test caught at the check and one in any other test caught at `finish`, `group` and `task` as opt-ins |
| `tests/timeline.sh` | the timeline of a change: a fake run writes its events in order, a plan edited mid-build becomes one decision entry with what changed, the reason and the owner approval state, parallel appends lose no line, `archive` keeps the timeline |
| `tests/visual-cache.sh` | `visual.changed_only` (a pass is not repeated; test and Markdown edits do not matter, a changed page does; a failing run is never stored; `SPEC_NO_CACHE`) and `visual.scope` (default `task`: own scenario per task, the other spec's scenario at `finish`; `all`: every scenario per task) |
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
| `tests/prose-lint.sh` | the prose lint (`scripts/prose-lint.cjs`): each rule, `--strict`, what it skips, `--metrics`, the vague-THEN info in `verify-task lint`, no shipped sentence above 60 words |
| `tests/drift.sh` | docs, options, skills and generated files stay in step; the `spec-writing` skill loaded where specs are written and passing its own rules |
