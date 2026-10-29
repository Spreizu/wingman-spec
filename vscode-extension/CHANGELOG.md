# Changelog

## Unreleased

- The icon is rendered from `assets/icon.svg` in the repository. CI builds and packages the extension on every push to `main`.
- A `v*` tag publishes the extension to the VS Code Marketplace and Open VSX (used by Cursor). Marketplace metadata: categories, keywords, gallery banner, a shorter description.
- The publisher id is now `elmo-egers`, so the extension id is `elmo-egers.wingman-spec`. Uninstall a locally installed `elmoegers.wingman-spec` first.

## 0.11.2

- The change page's archive list stays quiet while work is in progress: with open or unverified tasks, no tasks or no verifier run it is one collapsed, muted line ("Before archive: 2 items") without buttons. It opens as a warning ("Blocking archive", yellow, with the steps) only when every task is ticked and something still blocks; steps the page header already offers are not repeated.
- One spacing token (`--section-gap`, 16 px) separates the top-level sections of every page; the pipeline card no longer touches the stat cards. All stat cards have the same 3 px left border (CHECKS had none). `test/browser/page-sections.mjs` measures the gaps at 375 and 900 px and fails on a gap under 12 px or an overlap.
- The task lint asks for `Visual: <scenario id>` on a task that changes UI files and has no `Visual:` line.
- Timeline tab on the change page and on archived changes: every build step in order, grouped by task, with results, durations, the gap since the previous step, idle periods over 15 minutes and plan changes with their reason; details open on click. It refreshes while the change is built.
- Extension icon. The README lists each page, command and setting in short tables; build and test notes moved to DEVELOPING.md (not packaged).
- The scripts changed this release (shorter instructions, the `spec-writing` skill, faster defaults: `Check level: targeted`, `visual.scope: task`, `visual.changed_only: on`, `visual.request_timeout: 3`); the extension reads the same files as before. Details in the repository changelog and `docs/speed.md`.

## 0.11.1

- Branch Review already included uncommitted and untracked files; the workflow no longer creates commits, so the review is the way to look at a finished change before you commit it. The accepted-gap notice no longer asks you to commit.
- The scripts changed this release (faster `check`, `finish`, `sync` and `archive`; a visual check that no longer waits per state for requests that never answer, plus the optional `visual.baseline`, `visual.page_timeout` and `visual.request_timeout`); the extension reads the same files as before. Details in the repository changelog and `docs/speed.md`.
- New opt-in config in the scripts (`Check level`, `visual.scope`, `visual.changed_only`) that runs the project's tests less often or checks fewer visual scenarios per task; the extension reads the same files. Details in `docs/speed.md`.
- Test fixtures use neutral names. No new commands.
- The anchor count is judged like the scripts do (above `anchor_max`, default 6, and only with weak anchors; `Anchors: many` or `anchor_many` skips it, also the sprawl warning).
- The requirement page no longer repeats an aggregate "Tests" line when its scenario rows carry the test links; scenario names with a test are real links (pointer cursor, hover, keyboard focus) and every other clickable label shares one link style.
- History, the overview, the archived page, the dashboard activity and the changes list show date and time (`YYYY-MM-DD HH:MM:SS`, your time zone) and are ordered by that time, newest first; a tooltip says where the time came from (recorded at archive, git, file time or only the date in the name).

## 0.11.0

- Fast-path changes (Size S, Risk none, no UI) show the app-map, design and ADR steps as skipped, and the task lint no longer asks for a review task on them (it still warns when a Size M/L, risky or UI change has none).
- The scripts changed this release (the verifier ticks task boxes, one dispatch per Size S change or task group, a result cache, explore and propose ask only what the repo cannot answer); the extension reads the same files as before. Details in the repository changelog.
- Removed five unused exports.

## 0.10.3

- Shared script fixes: `verify-task` finds a task's checkbox when OpenSpec 1.7.x gives no line number (Done-when details, `next` and `check` work again; a task that matches nothing is refused, never line 0), and visual `ignore-http:` also skips the `Failed to load resource` console error of a skipped URL (any status, matched by the URL the browser reports or by the same skipped failure).
- Visual steps: `do: click` / `hover` on a control that exists but is hidden at one viewport is skipped there with an info note in the visual report (strict form `click!` fails); a missing or covered control still fails.
- Tasks tab: the highlighted `next` task fills its card edge to edge, long words wrap inside the card, an empty group shows no `0/0`. Inline code in task, requirement, scenario and ADR text shows as code in every page; tree labels, tooltips, quick picks and hover text show it as plain text without backticks.

## 0.10.2

- Empty states are calm. A change without tasks or a run shows "No tasks yet", "no run yet", "not started" and "not set" as muted cards (no coloured border, no empty bar, no "0 verified", "0 lint errors" or "0 implementation tasks"); a sub-line appears only when it adds information. The "it starts with `next`" note and every other message from the verifier show `code` spans instead of literal backticks. No empty progress ring for a change without tasks; History no longer says "0 tasks completed".
- Anchor fit (shared with the scripts): translation files of other ecosystems are recognised by path, a marker with no code of its own in one is still flagged, stacked `@spec` lines no longer report the first as an unrelated anchor, and a constant holding an SQL query is not called boilerplate.

## 0.10.1

- A change's `adrs/none.md` (`status: none`) is no longer counted as an ADR: no "1 ADR" pill on History cards, no count or card on the ADR tab, no Promote button, no entry in the History ADR tab. It shows once as a muted line "No architectural decision: <reason>". The editor still lints the file (it needs no Context, Decision or Consequences), and the script and the editor now share one definition of "none" (file `none.md`, `status: none` in any case, or both).

## 0.10.0

- Every requirement carries a one-line **Why** (`Why: <who wants it, and why>`) under its SHALL sentence, shown in the requirement card, hover, code lens, tree and branch review. The separate intents (intent files, `IN-` ids, `Derives:`, journey scenarios, the Intents page and the `Reveal Intent` command) are gone.
- The tree view is "Requirements & traceability": requirements per capability with their Why; per pending change the requirements without a Why and the ones whose Why is rewritten or that are removed. The dashboard blocks the archive with "Owner approval missing" for exactly those, until the proposal has an `Owner approval:` line.
- Problems: `missing-why` and `why-too-short`, with a quick fix that inserts an empty `Why: ` line.
- The roadmap page shows slices, next up and coverage; the intent trace is gone.
- A statement no longer includes its `Why:`, `Accepted:` or `Confirmed:` lines.

## 0.9.9

- Version bump alongside the apply-run state work in the scripts (run owner, lock, status lines); the run files the editor reads are unchanged.

## 0.9.8

- Visual blocks accept `ignore: <code>` and `ignore-http: <text>` (skip defects of other teams, with a count and a list in the check output); the editor reports the same refusals as the scripts (an empty value, a bare `:`, codes that prove the scenario's own claim such as a missing key element, `expect`, `absent`).

## 0.9.7

- Over-anchored `@spec` markers (on imports, types, string tables, logging, another capability's files, or beyond three per requirement) are shown in the code and in the problems list, with a quick action that removes just the marker. The last anchor of a requirement is never offered for removal. `anchor_fit: off` hides them.
- A change that is only "not synced yet" shows `/spec-archive` as the action (it syncs first); Overview and the change page offer Archive for a finished change instead of a sync check.

## 0.9.6

- Fixed `Visual block: unknown field "role"` (also `absent`, `redirects-to`, `state` lines): visual blocks, task-plan rules, size caps, UI-file list and scan rules now come from the toolkit's scripts instead of copies in the extension. A parity test compares the editor with `problems --json`.
- Spec parsing ignores headings inside fenced code and reads sections, renames and `## Purpose` like the scripts.
- `*.test.vue`, `*.spec.vue`, `*.test.svelte`, `*.spec.svelte` are test files.
- Overview: the change name no longer overlaps the BLOCKED text in "Needs a product decision" (also "ADRs need syncing", ADR hub "Waiting in changes"); long text is cut after two lines.
- Fewer pills on cards: none/empty/zero pills, repeated pills and healthy-state pills are not drawn (the "No architectural decision" card had "none" and "None"). Only exceptions show.

## 0.9.5

- Test files of PHP, Java, Kotlin, Scala, C#, Swift, Dart, Elixir, C/C++, Clojure and Lua are read for `[capability/scenario]` tags (they showed "0/2 scenarios tested"). The extension uses the toolkit's `testpaths.cjs`, the one definition of which files are tests.

## 0.9.4

- Version aligned with the toolkit; no change to the extension code.

## 0.9.3

- Version aligned with the toolkit; no change to the extension code (it already watches `openspec/greenfield/**`, so the new `records/` folder refreshes the views).

## 0.9.2

- The file watcher also reacts to changes in `openspec/intents/`, `observed/`, `roadmap/`, `greenfield/` and to code files, so the drift view and Problems panel refresh after an anchor edit.
- The verifier output is read with a 64 MB buffer.

## 0.9.1

- Version aligned with the schema 0.9.1 (the installer now always overwrites installed skills); no extension change.

## 0.9.0

- Accepted drift gaps come from an `Accepted: <reason>` line on the requirement in its spec; `openspec/drift-decisions/` is no longer read. The drift tree shows `accepted: <reason>` and counts them apart from open gaps.
- The quick fix and command `Wingman Spec: Accept Drift Gap` replace the decision command and add that line through `drift decide --accept`; redo and amend are gone. The fix kind `decide` is now `accept`.

## 0.8.0

- The Intents list reads only `openspec/intents/`; the old single `openspec/intents.md` and `openspec/drift-decisions.json` are no longer read.

## 0.7.1

- Command references in the roadmap view and README follow the rename: `/spec-green-start`, `/spec-green-plan`, `/spec-green-next`.

## 0.7.0

- **Intent page**: under each requirement that derives from the intent, a closed "Where it is (n places)" list with a `file:line` link for every code anchor and test (the same link rows as the requirement card). A click in the list opens the file or the list, never the card's own link. Tests: markup tests, plus `test/browser/intent-links.mjs` (headless Chromium, needs Playwright: clicks, no horizontal scroll at 1000 and 420 px, screenshots written to a folder, none committed). ADR views are unchanged.

- Edits keep what a person wrote: marker fixes keep CRLF files CRLF; promoting an ADR no longer writes an `adr/README.md` table (the README is static) and keeps the header keys and comments of an edited ADR; marking an ADR superseded works on CRLF files.

- **Roadmap** page (`Wingman Spec: Open Roadmap (new product)`; the navigation link shows only when `openspec/greenfield.yaml` exists): the slices of `openspec/roadmap/` in build order with status (planned, proposed, applying, done), size, milestone, walking skeleton, contract tests and dependencies, what is next up, requirements or intents in no slice, and the intent to slices trace. Read-only: it shows what `verify-task.cjs roadmap --json` says and writes nothing. In a project that is not a new product the page shows the verifier's refusal.
- Tests: parsing, the verifier call (exit 1 with JSON, exit 6 refusal), the page, the background loading. Not tested in a real VS Code window.

## 0.6.0

- **Branch review** page (`Wingman Spec: Open Branch Review`, last node of the traceability tree): the current git branch against its base. Requirements and intents the diff touches, anchors added/removed/moved/changed, requirements not fully tested, verifier findings in the diff; rows open the requirement in the extension page or the code. Settings `branchReviewBase`, `branchReviewGit`.
- **Change dashboard** on `wingman-spec` change pages: tasks (with verified / ticked / review-pending marks), checks, review state, size S/M/L, intents with journey and approval flags, and a "Blocking archive" list where every entry says what to do (copy, open in a terminal, send to the agent, open a file). Setting `dashboardChecks`.
- **Problems panel**: diagnostics from `verify-task.cjs problems --json` (lint, placement, drift gaps, stale and changed anchors, intents, `Derives:`), refreshed on save and by `Wingman Spec: Refresh Problems`; quick fixes including `drift decide`. Setting `problemsPanel`; `verifierNode`, `verifierTimeoutSeconds`.
- `@spec` CodeLens and hover: `Spec` (opens the requirement in the page), `Tests (n)` / `Add test`, `Code (n)`, intent, `Run tests` (`runTestsLens`), move-marker action; quick fixes for unknown keys and misplaced markers.
- Pills on cards (overview, specs, history) share one container, so they have a gap and sit 12px below the text (they touched before).
- Tests: stub-host smoke for the new layer, real git repositories as fixtures, render tests. Not tested in a real VS Code window.
- Known limits: git runs through `child_process` (not the VS Code git API) and needs `git` and `node` on the PATH; the extension's drift tree still does not compute stale/misplaced gaps (they come through the Problems panel); below 480px width the page has a horizontal scroll (existing layout).

## 0.5.0

- Marker placement findings (`trailing-marker`, `duplicate-marker`, `file-top-marker`, `detached-marker`) as warnings or errors in the code view, with the severity from `anchor_placement` in `openspec/config.yaml`; shares `placement.cjs` with the verifier.
- Reads one file per intent (`openspec/intents/IN-<name>.md`, descriptive ids) and per-capability drift decisions; anchors come from the `@spec` markers (there is no `anchors.json` any more).
- Removed the timing support (overview table, session stats, change-page card).

## 0.4.1

- The author is Elmo Egers and the publisher id is now `elmoegers`, so the extension id is `elmoegers.wingman-spec`. Uninstall the
  0.4.0 build (id with the old publisher) before installing this one, or both show up. No functional change.

## 0.4.0

- **Intents and traceability** for the intents layer (terminology: intents `IN-n`, journey scenario, `Derives:`).
  - New Explorer view "Wingman Spec: Intents & Traceability": living intents and each pending change's
    intents, with the requirements that derive from them, their journey scenario and code/test anchors; flags for an
    orphan requirement, an intent without a journey or requirement, intent changes needing owner approval and an
    unsynced archive; a Drift group with the same gap types as `verify-task.cjs drift` (read from the files, nothing is run).
  - Code view for `@spec <capability>/<requirement-slug>` markers in any file (same comment forms as the verifier):
    CodeLens (requirement, anchor and test counts), hover (requirement, intent, scenarios), go to definition,
    warnings for unresolved markers (with a did-you-mean hint) and unresolved `[capability/scenario]` test tags.
    Reverse lookup: anchor counts above each requirement in a base spec, and `Show Anchors of Requirement`.
  - New setting `wingmanSpec.codeView` (default on) turns the code view off.
  - New pure modules `model/intents.ts`, `model/anchors.ts`, `model/traceability.ts`, `model/anchorView.ts` and
    `model/traceTree.ts`, with unit tests that need no VS Code host.
  - Not done: an intents block on the change page of the dashboard; scanning honours the verifier's skip rules but not `.gitignore`.

## Unreleased

- Renamed from the earlier "Spec Explorer" (package `analyst-spec-explorer`) to **Wingman Spec** (package `wingman-spec`), to match the
  schema, which is now `wingman-spec` (it was `analyst-driven`). There is no alias for the old name.
  - Command ids `analystSpec.*` are now `wingmanSpec.*`; settings `analystSpec.*` are now `wingmanSpec.*`
    (`adrDirectory`, `openspecPath`, `diagnostics`, `codeLens`). Copy any value you had set into the new key.
  - Titles read "Wingman Spec: ..."; the status bar item, dashboard title and diagnostics source read "Wingman Spec".
  - Only projects whose config or change metadata says `schema: wingman-spec` get the full dashboard (pipeline, app map);
    other schemas list tasks only, as before.
  - Author is Elmo Egers and the publisher id is `elmoegers`, so the extension id is now `elmoegers.wingman-spec`. Uninstall the old `analyst-spec-explorer`
    build before installing the new one.
