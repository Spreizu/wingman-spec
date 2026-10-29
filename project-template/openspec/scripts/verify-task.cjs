#!/usr/bin/env node
'use strict';
/*
 * verify-task.cjs - deterministic gate for the subagent apply flow. No harness dependency (plain Node >= 18).
 *
 * The main agent (orchestrator) drives the loop; a subagent implements one task; this script decides.
 *
 *   node openspec/scripts/verify-task.cjs next  <change> [opts]   pick the next task and print its context packet
 *   node openspec/scripts/verify-task.cjs check <change> [opts]   verify the task handed out by `next`
 *                                                                `next` hands out one dispatch: a Size S change is one batch (all its tasks except a review
 *                                                                task), a Size M/L change one batch per task group, a change without Size one task; a review
 *                                                                task is always alone; `--per-task` forces one task per dispatch. `check` verifies the batch
 *                                                                once (every Done when, the project checks once) and the verifier ticks every task of it
 *                                                                A passing tests/typecheck/lint result is reused by `check` and `finish` while the working tree and the
 *                                                                command are unchanged (`--no-cache` or SPEC_NO_CACHE=1: run them again); `finish` runs them in parallel
 *                                                                Defaults: `check` runs the task's targeted tests (test files changed since the change began,
 *                                                                tests tagged with its scenarios, tests named after its source files; `- Targeted test command:`
 *                                                                or a template from the test command), typecheck and lint at the check that ends a task group,
 *                                                                the full test suite only at `finish` (`- Check level: group` runs it at a group's last check,
 *                                                                `task` at every check, `finish` runs nothing at check; SPEC_CHECK_LEVEL); a task's visual check covers its own scenarios (`visual.scope: all` adds the
 *                                                                others); a visual run that passed is not repeated while the app files are unchanged (`visual.changed_only: off`
 *                                                                turns that off; `visual --changed-only` forces it on for one run). A task's Done when always runs. `finish` always runs every
 *                                                                command and every visual scenario.
 *   node openspec/scripts/verify-task.cjs status <change> [opts]  progress as JSON (OpenSpec's count)
 *   node openspec/scripts/verify-task.cjs lint  <change> [opts]   report checkbox lines OpenSpec would miscount, broken
 *                                                                ```visual blocks, bad `Visual:` lines, uncovered scenarios,
 *                                                                plan size (Size: S|M|L in proposal.md caps 3/5/8 implementation
 *                                                                tasks; error), the size check below, extra group reviews,
 *                                                                close-out tasks, merge candidates, invariant scenarios (warning)
 *   node openspec/scripts/verify-task.cjs size  <change> [opts]   the declared Size (proposal.md) against what the specs need:
 *                                                                S = 1 capability, <= 3 requirements, no BREAKING, no ADRs, no
 *                                                                visual blocks; M = <= 2 capabilities (or UI with visual
 *                                                                scenarios); L = 3+ capabilities, BREAKING, a Risk: or a (risky)
 *                                                                group. Exit 1 when the change is under-declared (upgrade the
 *                                                                size and write the full artifacts) or an M/L change has the
 *                                                                light S artifacts. lint and next run it too.
 *   node openspec/scripts/verify-task.cjs app-map <change> [--apply]   the two-line app map of a Size S change, generated from its specs
 *                                                                (a Size M/L change gets the full map from the analyst). Fast path: Size S + Risk none + no
 *                                                                sensitive path + no UI + no dependency manifest needs no app-map, design.md or adrs/none.md;
 *                                                                `check` and `finish` upgrade a change whose edits leave that scope (upgrade.json in the run dir)
 *   node openspec/scripts/verify-task.cjs review <change> --reply FILE   record the spec-visual-reviewer verdict (after exit 5)
 *   node openspec/scripts/verify-task.cjs visual <change> [--scenario ID]...   run the visual check on its own
 *                                                                (implementer self-check: defects, ARIA changes, area images)
 *   node openspec/scripts/verify-task.cjs finish <change> [opts]  after the last task: the deterministic close-out (full tests,
 *                                                                typecheck, lint, validate, visual, trace tags, source-text rule)
 *   node openspec/scripts/verify-task.cjs guard <change> [--base REF]   the anchor guard on its own: which anchored code changed since the
 *                                                                change began (default base: the commit `next` recorded) without its requirement being mentioned
 *   node openspec/scripts/verify-task.cjs doctor [opts]           config and environment: test/typecheck/lint commands, visual, Playwright
 *   node openspec/scripts/verify-task.cjs design-system [--format json]   the project's design system (tokens, Tailwind
 *                                                                theme, UI library config, shared components and their variants),
 *                                                                read by /spec-explore before it maps a design (design-contract.cjs)
 *   node openspec/scripts/verify-task.cjs sync <change>           after /spec-sync merged the delta specs and promoted the ADRs: check the change is
 *                                                                fully synced (the same read-only check as sync-check; it writes nothing)
 *   node openspec/scripts/verify-task.cjs sync-check <change>     the same check, read-only (exit 1 when not synced)
 *   node openspec/scripts/verify-task.cjs archive <change>        the only way to archive: refuses an unsynced change (exit 1), then moves
 *                                                                it to openspec/changes/archive/. (A bare `openspec archive` in a shell
 *                                                                cannot be stopped; `drift` reports it afterwards as `unsynced-archive`.)
 *   node openspec/scripts/verify-task.cjs anchors prune [--apply] [--select <file>:<line>,...]   over-anchored markers (anchor_fit): list the ones that can go, or with --apply remove just those marker lines (never a requirement's last anchor, never code)
 *   node openspec/scripts/verify-task.cjs anchors [<change>] [--json]   resolve every `@spec` marker in the code (the markers are the index: nothing is stored); --json adds the derived index
 *   node openspec/scripts/verify-task.cjs adrs [--fix]            the promoted ADRs (adr/NNNN-slug.md); exit 1 when two share a number (parallel
 *                                                                branches); --fix renumbers the later ones. adr/README.md carries no table.
 *   node openspec/scripts/verify-task.cjs problems [<change>] [--json]   every finding as one located list (file, line, severity, repair): lint of the active changes, drift
 *                                                                gaps, anchor guard; read-only, always exit 0; this is what the VS Code extension shows under Problems
 *   node openspec/scripts/verify-task.cjs drift [--text]          requirements without a code anchor or test, anchors on removed/renamed
 *                                                                requirements, tests tagged to missing scenarios,
 *                                                                changes archived without a sync, adopted requirements without a
 *                                                                `Confirmed:` line, incomplete openspec/observed entries (JSON, or --text for people)
 *   node openspec/scripts/verify-task.cjs drift decide <gap-key> --accept --note TEXT | --all GAP-TYPE --accept --note TEXT
 *                                                                accept = write `Accepted: <reason>` on the gap's requirement in openspec/specs/<cap>/spec.md
 *                                                                (only that line changes; unanchored, untested and stale-anchor gaps); a gap you do not accept is
 *                                                                fixed. --all accepts every open gap of one type, one line per requirement (e.g. a brownfield backlog)
 *   node openspec/scripts/verify-task.cjs help                    print this reference
 *
 * Task list: `openspec instructions apply --change <c> --json` is the only counting source.
 * `next` refuses (exit 2) when tasks.md has checkboxes inside code fences or nested checkboxes, because
 * OpenSpec counts those as tasks and the change could never complete.
 *
 * `check` passes only if ALL hold, each external command with a timeout:
 *   1. tasks.md differs from the pre-task snapshot by at most the target task's `[ ]` -> `[x]` (the agent does not tick:
 *      the verifier ticks the box itself when everything passes; no other task ticked, unticked, added, deleted or
 *      reworded; no detail line edited)
 *   2. the subagent did not report failure (--reported failed|blocked) and BLOCKED.md does not exist
 *   3. the task's `Done when:` command (first `backticked` span, taken from the snapshot) exits 0
 *   4. the project test command exits 0 (--test-cmd, $SPEC_TEST_CMD, or "Test command:" in openspec/config.yaml;
 *      `next` and `check` refuse while it is still the `<fill in>` placeholder; `Test command: none` opts out)
 *   5. the visual check (visual-check.cjs), when the task names scenarios (`Visual:` line) or changed UI files.
 *      Screenshot-free: the app is started from `visual:` in openspec/config.yaml and every declared scenario state is
 *      opened at each viewport; console/page errors, failed or >=400 requests, axe wcag2a/aa violations, horizontal
 *      overflow, missing/hidden/offscreen/overlapping key elements and broken images fail it (for scenarios outside
 *      the task: only defects that were not there before the task), and so does a change of the ARIA snapshot of a
 *      declared scenario outside the task's scope. "Before" is captured by `next` from the pre-task tree (fallback:
 *      a temporary git worktree of HEAD); nothing is stored in the repository.
 *   4b. the typecheck and lint commands ("Typecheck command:" / "Lint command:" in openspec/config.yaml, detected by the
 *      installer), each skipped when the task's `Done when:` already ran exactly that command (also the test command)
 *   4c. no test file this task changed reads source files as text (`?raw` imports, readFileSync of src/, .vue, .css ...;
 *      opt-out: a `source-text-ok: <reason>` comment), and every scenario the task's `Spec:` line names one by one has a
 *      test tagged `[capability/scenario-slug]` (visual scenarios are covered by the visual check)
 *   6. `openspec validate <change> --strict` exits 0
 * On failure tasks.md is restored from the snapshot and the attempt is counted; on success the verifier ticks the task.
 * When the task named visual scenarios and everything passed, `check` exits 5 (review pending) with a reviewer prompt
 * listing before/after clip screenshots of the task's affected areas and their ARIA diff (`visual.screenshots: off` or
 * `visual.review: off`: no images, no review);
 * `review --reply FILE` then passes the task (STATUS: pass) or rejects it like a failing test (DEFECT lines).
 *
 * Exit codes: 0 ok (next: task ready | check/review: passed) · 10 next: all tasks done · 1 check failed, retry allowed
 *             4 attempts exhausted: stop and report · 3 BLOCKED.md present: stop · 2 usage or environment error
 *             5 check: deterministic checks passed, visual review pending (dispatch spec-visual-reviewer, then `review`)
 *             6 REFUSED by the project-mode guard (greenfield commands on a brownfield project and the reverse): nothing was written
 *
 * New-product (greenfield) commands live in greenfield.cjs; they read files only and are refused outside a greenfield project:
 *   verify-task.cjs mode [--for CMD] [--json]    greenfield | brownfield | greenfield-in-progress | implementation, and why
 *   verify-task.cjs greenfield status [--json]   phase, step, the exact next action, what blocks it (Done / Next / Blocked by)
 *   verify-task.cjs greenfield start --by NAME --yes | new <kind> | approve <understood|spec> --by NAME | review <spec|plan|dryrun> | readme
 *   verify-task.cjs roadmap [--next] [--json]    the slices of openspec/roadmap/: order, graph errors, size caps, coverage, next up
 *   verify-task.cjs handover [--write] [--json]  the readiness gate (the exact list of what is missing); --write records the manifest
 *
 * Options: --root DIR | --store ID   OpenSpec root (default: detected like the /spec-* commands)
 *          --timeout SEC             per external check (default 600); SPEC_TIMEOUT_<TESTS|TYPECHECK|LINT|DONE_WHEN|VALIDATE> sets one command's limit
 *          --timing                  `check`/`finish`: print what each command and scan cost, most expensive first (also SPEC_PROFILE=1), and record it in metrics.jsonl
 *          --max-attempts N          per task, including the first (default 3)
 *          --test-cmd CMD            project tests ("" disables)
 *          --reported done|failed|blocked   what the subagent said it did (default done)
 *          --format json|prompt      `next` output: JSON packet (default) or the ready subagent prompt
 *          --new-run                 `next`: close the current run (e.g. after an exhausted task was fixed) and start a new one
 *          --session ID              who is running (also SPEC_SESSION): next, check and review refuse a run that another session started
 *                                    less than 30 min ago; `status` and every next/check/review/finish output carry `run_status`
 *          --takeover                adopt a run of another session or worktree (or replace a lock whose holder is dead)
 *          --reason TEXT             next, check, finish: why the plan changed, recorded in the decision entry of the timeline
 *                                    (else the last `Decision:` line of the change); see timeline.cjs
 *          --reply FILE              `review`: the reviewer's reply (DEFECT: lines and a STATUS: pass|fail line; - = stdin)
 *          --reviewer subagent|none  `review`: subagent = an independent spec-visual-reviewer wrote the reply; none = no independent
 *                                    reviewer could be dispatched: records the review as skipped (no --reply). The implementer never
 *                                    reviews its own screenshots (`self` is refused).
 *          --scenario ID             `visual`: limit to this scenario id (<capability>/<scenario-slug>); repeatable
 *          --fix                     `adrs`: renumber duplicate ADR numbers
 *          --json | --text           `anchors`: also print the derived index | `drift`: human-readable report
 *          --accept, --note TEXT (required), --all GAP-TYPE   `drift decide`
 *
 * `next` also refuses (exit 2, `unverified-ticks`) while tasks.md has a ticked task no `check` passed: run `check` for it (after a failed
 * check, `check` opens the next attempt itself: no untick, `next` or re-tick), or untick any other such task.
 * Config placeholders: `next` and `check` refuse (exit 2) while `Test command:` is `<fill in>` (`none` opts out) and while a task with
 * `Visual:` lacks `visual:` `command`/`url`. `doctor` lists what is missing and which file each command comes from (also Playwright,
 * Chromium, axe-core); Chromium is looked up in PLAYWRIGHT_BROWSERS_PATH, the default cache and next to the Playwright install
 * (`visual.browsers_path` pins it). In a workspace layout the code repository's openspec/config.yaml / workspace.yaml is read first, then
 * the store's; if the store is not registered or the specs folder is missing, `doctor` prints the clone and `openspec store register`
 * steps: show them to the user and stop.
 *
 * Tasks format: checkboxes only at the top level, never inside code fences or nested; `Done when:` names its command in backticks;
 * UI tasks add `Visual: <scenario ids>|all`. `lint` checks this, the visual blocks, and that every visual scenario is named by a task.
 * Size/plan size: proposal.md starts with `Size: S|M|L` and `Risk: none|<kinds>` (security, money, data-migration, concurrency,
 * public-api): the one source of the size (a different `Size:` in tasks.md is an error). One final review of the whole change; group
 * reviews only after group 1 of an L change and after groups whose heading says `(risky)`; no close-out tasks (`finish` does them).
 *
 * Visual loop (visual: in openspec/config.yaml; scenarios are ```visual blocks in the specs): route:, key: selectors, state: + do:
 * steps, viewports: (default 375/768/1280), reference:, overlay:, component:, expect: lines, and for gated features role:, absent:,
 * redirects-to: (see Visual roles below). `next` records the pre-task state, so
 * change nothing between `next` and the subagent. The app is started from `visual.command` and probed at `visual.url`. Certificate
 * errors are ignored by default (`visual.ignore_https_errors: true`: Playwright `ignoreHTTPSErrors` and the readiness probe accept a
 * self-signed https dev server; `false` = strict). Nothing is stored in the repository (no baselines); `visual.screenshots: off`
 * takes no images and skips the review. Without Playwright the check is skipped with a loud WARNING (never report that as passed);
 * `visual.require_playwright: true` fails instead. Accessible names: a control's name contains its visible text (axe
 * label-content-name-mismatch); add context with visually hidden text that starts with an explicit space, aria-hidden on decorative
 * badges or aria-describedby; live regions stay rendered and change their text.
 *
 * Traceability (`traceability: on|warn|off` in openspec/config.yaml; `warn` turns every finding into a warning, `off`, the default
 * when the key is absent, disables the Why check and anchors; sync before archive is enforced in every mode): every ADDED or MODIFIED
 * requirement says `Why: <who wants it, and why>` (one line) under its SHALL statement (`missing-why`, `why-too-short`), `@spec <capability>/
 * <requirement-slug>` comments in code and tests. Rewriting the Why of a living requirement, or removing a requirement, needs
 * `Owner approval: <name>, <date>` in proposal.md (lint fails until it is there; `finish` lists it under `why_owner_approval`).
 * Marker placement (`anchor_placement: warn|error|off`, default warn): the rules and the heuristic are in placement.cjs.
 *
 * Anchor guard (`anchor_guard: warn|error|off`, default warn; anchorguard.cjs; `guard <change> [--base REF]` prints it): a `@spec` anchor says
 * "this code implements that requirement", so when the anchored code changes the requirement must be looked at. `check` (against HEAD) and
 * `finish` (against the commit `next` recorded) diff the change and report `anchor-touched-unlisted` (an anchored function or the lines
 * under a marker changed, or got a new anchor, and the change does not mention the requirement: no delta, no `Spec:` line; answer by updating
 * the delta, or a line `Reviewed anchors: <cap>/<req> - <why it still holds>` in tasks.md or progress.md), `requirement-changed-code-untouched`
 * (a MODIFIED requirement whose anchored code did not change), `anchor-removed` / `anchor-moved` (the anchored unit was deleted, renamed away or
 * moved), `anchor-sprawl` (more than 6 code anchors in more than 3 files for one requirement, unless it says `Anchors: many`) and `anchor-outside-task-files` (an anchor
 * added or changed in a file the task's `Files:` line does not list). Formatting, blank lines, comments, other functions of the same file,
 * files without markers and generated/vendored files never count. `error` makes the findings fail when traceability is `on`.
 * Test evidence (`test_evidence: warn|strict|off`, default warn): `finish` reads the test command's output and reports per requirement of
 * the change whether its tagged tests show up passing (`passed`), failing or skipped (`failed`: always an error) or are not named in the
 * output (`unlisted`: a quiet reporter; warn, error with `strict`). `check`/`finish` fail before that when the test command itself fails.
 * Stale anchors (`anchor_stale: info|warn|error|off`, default info; `drift`): outside a change, a unit whose code changed in a commit later than
 * the last commit of its requirement's text (git blame, whitespace and comment-only edits and commits that also touched the spec ignored;
 * skipped with a note in shallow clones or without git) is listed as `stale-anchor`. `drift decide stale-anchor:<key> --accept --note` writes
 * an `Accepted:` line on the requirement: once committed, the requirement text is newer than the code again; a later code change reopens it. `drift` also reports `misplaced-marker` (placement findings, same `anchor_placement` level:
 * `warn` is advisory, `error` fails, `off` hides). Advisory gaps (warn/info) are listed and never change the exit code.
 * Observed, unconfirmed (/spec-adopt): a spec whose Purpose carries `Baseline: adopted <date>` was written from existing code; each of its
 * requirements without `Why:` needs a `Confirmed: test <file>: <name> | doc <file> | owner <name>, <date>` line, else `drift` lists
 * `unconfirmed-requirement` (advisory). Behavior nobody confirmed (suspected bug, debug leftover, incidental detail, unclear) is kept in
 * openspec/observed/<capability>.md instead (one `## <slug>` entry with Observed, Why unconfirmed, Owner, To confirm; no index);
 * `observed-incomplete` is listed when an entry lacks one of them. `drift --text` counts the open entries.
 *
 * Visual roles (`visual.roles:` in openspec/config.yaml; roles.cjs): `role: admin` in a visual block logs in as that role first (a form login on
 * the role's `login:` path with the user and password from the env vars WINGMAN_ROLE_<NAME>_USER / _PASSWORD, or names set per role with
 * `user_env:` / `password_env:`, or from the gitignored openspec/.local/roles.yaml). `absent: <selector>` fails when the element is visible
 * to that role; `redirects-to: /login` fails unless the route ends there (the anonymous check of a gated page). Other role fields:
 * `success:` (path or selector that proves the login worked), `user_field:`, `password_field:`, `submit:`, and `storage_state:` (a recorded
 * Playwright session file, for SSO/MFA/captcha logins). Credentials are never written to config.yaml or a spec; sessions are saved to the
 * openspec/.local/auth/ (self-ignoring) and passwords are never printed. `doctor` lists each role and what it still lacks.
 *
 * Skipping defects the change does not own: `ignore: a11y:` (a code, or a prefix ending in ":") and `ignore-http: /static/images/` (a text the
 * message contains) in a visual block, `visual.ignore` / `visual.ignore_http` in openspec/config.yaml for every scenario. Only a11y:*, runtime:*,
 * content:* and layout:horizontal-overflow can be skipped; key, expect, absent, role and state failures cannot (refused, like empty values, a
 * bare ":" and a too-short text). Skipped defects are not failures but are listed in the output as "ignored (n)" and in report.json.
 *
 * Run log (never committed): <root>/openspec/.apply-runs/<change>/<run-id>/{state.json,metrics.jsonl,pre/,visual/}
 * Run state (runstate.cjs): <run-id>/run.json holds the owner (session, worktree, pid), the branch, HEAD, tree hash and start; verified.json
 * records, per passing task, the run, session, HEAD, branch, worktree, tree hash and the hash of the task's `Files:`; finished.json records
 * the last passing `finish`. A record whose commit is not in this checkout's history and whose files differ is not trusted: `next` returns
 * unverified-ticks with a `foreign` list. lock.json (pid, session, command, heartbeat every 15 s, stale after 2 min) allows one live
 * next/check/review/finish per change (`busy`). A run started by another session or worktree less than 30 idle minutes ago is refused
 * (`run-owned`); --takeover adopts it (logged as a `takeover` metric). Separate git worktrees have their own .apply-runs; a shared
 * specs repository (workspace layout) serializes them instead. Every next/check/review/finish output has `run_status`.
 *   visual/<task>/before/ (captured by `next`), visual/<task>-a<N>/ (after, per attempt): report.json with the ARIA
 *   snapshots, and areas/ with the clip screenshots of the task's own scenarios. Ephemeral; nothing is committed.
 * One run directory per apply session; metrics.jsonl is append-only. The directory ignores itself in git.
 */
// The commands end with process.exit(); on a pipe Node would drop what is still buffered (output above 64 KB was cut).
// Blocking stdout/stderr make every write complete before the exit.
for (const s of [process.stdout, process.stderr]) if (s._handle && typeof s._handle.setBlocking === 'function') s._handle.setBlocking(true);
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const VC = require('./visual-check.cjs');
const RL = require('./roles.cjs');
const Q = require('./quality.cjs');
const TP = require('./testpaths.cjs');
const TL = require('./timeline.cjs');
const DC = require('./design-contract.cjs');
const T = require('./traceability.cjs');
const AG = require('./anchorguard.cjs');
const FIT = require('./anchorfit.cjs');
const CH = require('./chronology.cjs');
const PR = require('./problems.cjs');
const RS = require('./runstate.cjs');

const EXIT = { OK: 0, FAIL: 1, USAGE: 2, BLOCKED: 3, EXHAUSTED: 4, REVIEW: 5, DONE: 10 };
const TAIL = 4000;

function die(msg, code = EXIT.USAGE) { process.stderr.write(`verify-task: ${msg}\n`); process.exit(code); }

function printHelp() {
  const m = fs.readFileSync(__filename, 'utf8').match(/\/\*([\s\S]*?)\*\//);
  process.stdout.write(m[1].replace(/^\n/, '').split('\n').map((l) => l.replace(/^ \* ?/, '')).join('\n').replace(/\s+$/, '') + '\n');
}

function parseArgs(argv) {
  if (['help', '--help', '-h'].includes(argv[0])) { printHelp(); process.exit(0); }
  const o = { cmd: argv[0], change: argv[1], timeout: 600, maxAttempts: 3, reported: 'done', format: 'json', scenarios: [], reviewer: 'subagent' };
  if (o.cmd === 'drift') { // drift [decide <gap-key>] [opts]: no change name
    o.sub = argv[1] && !argv[1].startsWith('-') ? argv[1] : null; o.key = o.sub === 'decide' && argv[2] && !argv[2].startsWith('-') ? argv[2] : null;
    argv = [argv[0], '', ...argv.slice(o.sub ? (o.key ? 3 : 2) : 1)]; o.change = null;
  } else if (o.cmd === 'anchors' && argv[1] === 'prune') { o.sub = 'prune'; o.change = null; argv = [argv[0], '', ...argv.slice(2)];
  } else if ((o.cmd === 'anchors' || o.cmd === 'adrs' || o.cmd === 'problems') && (o.change === undefined || o.change.startsWith('-'))) { argv = [argv[0], '', ...argv.slice(1)]; o.change = null; }
  else if ((o.cmd === 'doctor' || o.cmd === 'design-system') && (o.change === undefined || o.change.startsWith('-'))) { o.change = null; argv = [argv[0], '', ...argv.slice(1)]; }
  const posInt = (k, v) => { if (!/^[1-9][0-9]*$/.test(String(v))) die(`${k} needs a positive integer, got '${v}'`); return Number(v); };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]; const v = argv[i + 1];
    const need = () => { if (v === undefined) die(`${a} needs a value`); i++; return v; };
    switch (a) {
      case '--root': o.root = need(); break;
      case '--store': o.store = need(); break;
      case '--timeout': o.timeout = posInt(a, need()); break;
      case '--max-attempts': o.maxAttempts = posInt(a, need()); break;
      case '--test-cmd': o.testCmd = need(); break;
      case '--reported': o.reported = need(); if (!['done', 'failed', 'blocked'].includes(o.reported)) die('--reported must be done|failed|blocked'); break;
      case '--new-run': o.newRun = true; break;
      case '--per-task': o.perTask = true; break;
      case '--no-cache': o.noCache = true; break;
      case '--changed-only': o.changedOnly = true; break;
      case '--timing': o.timing = true; break;
      case '--session': o.session = need(); if (!/^[A-Za-z0-9._:-]{1,64}$/.test(o.session)) die('--session needs 1-64 letters, digits or . _ : -'); break;
      case '--takeover': o.takeover = true; break;
      case '--format': o.formatGiven = true; o.format = need(); if (!['json', 'prompt'].includes(o.format)) die('--format must be json|prompt'); break;
      case '--reply': o.reply = need(); break;
      case '--reviewer': o.reviewer = need(); if (o.reviewer === 'self') die('--reviewer self is not allowed: the implementer does not review its own screenshots. Dispatch an independent spec-visual-reviewer subagent, or record the review as skipped with --reviewer none'); if (!['subagent', 'none'].includes(o.reviewer)) die('--reviewer must be subagent|none'); break;
      case '--scenario': o.scenarios.push(need()); break;
      case '--note': o.note = need(); break;
      case '--reason': o.reason = need(); break;
      case '--accept': o.accept = true; break;
      case '--all': o.all = need(); break;
      case '--base': o.base = need(); break;
      case '--json': o.json = true; break;
      case '--fix': o.fix = true; break;
      case '--apply': o.apply = true; break;
      case '--select': o.select = need().split(',').map((x) => x.trim()).filter(Boolean); break;
      case '--text': o.text = true; break;
      default: die(`unknown option ${a}`);
    }
  }
  if (['doctor', 'design-system', 'anchors', 'drift', 'adrs', 'problems'].includes(o.cmd) && !o.change) return o;
  if (!['next', 'check', 'status', 'lint', 'size', 'app-map', 'review', 'visual', 'finish', 'anchors', 'sync', 'sync-check', 'archive', 'adrs', 'guard', 'problems'].includes(o.cmd || '') || !o.change || o.change.startsWith('-')) {
    die('usage (verify-task.cjs help prints the full reference): next|check|status|lint|size|app-map|review|visual|finish|guard|problems|sync|sync-check|archive <change> | anchors [<change>] [--json] | adrs [--fix] | drift [decide <gap-key> --accept|--redo|--amend --note TEXT] | doctor | design-system [--root DIR|--store ID] [--timeout SEC] [--max-attempts N] [--test-cmd CMD] [--reported done|failed|blocked] [--format json|prompt] [--reply FILE] [--reviewer subagent|none] [--scenario ID]');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(o.change)) die(`invalid change name '${o.change}'`);
  if (o.cmd === 'review' && !o.reply && o.reviewer !== 'none') die('review needs --reply FILE (the reviewer\'s reply; - reads stdin)');
  return o;
}

// ---------- OpenSpec root (same order as the /spec-* commands) ----------
const CODE_ROOT = fs.realpathSync(process.env.OPENSPEC_PROJECT_ROOT || process.cwd());

function openspecJson(args, cwd, soft) {
  const r = RS.timed(`openspec ${args[0]}${args[1] && !args[1].startsWith('-') ? ' ' + args[1] : ''}`, () => spawnSync('openspec', args, { cwd, encoding: 'utf8', env: { ...process.env, OPENSPEC_TELEMETRY: '0' } }));
  if (r.error) { if (soft) return { missing: true, error: `cannot run openspec (${r.error.code})` }; die(`cannot run openspec (${r.error.code}); install the OpenSpec CLI`); }
  const s = r.stdout || '';
  const at = s.indexOf('{');
  if (r.status !== 0 || at < 0) {
    let json = null; try { if (at >= 0) json = JSON.parse(s.slice(at)); } catch (e) { /* not JSON */ }
    return { error: (r.stderr || s).trim() || `openspec ${args.join(' ')} exited ${r.status}`, json };
  }
  try { return JSON.parse(s.slice(at)); } catch (e) { return { error: `unparsable JSON from openspec ${args[0]}` }; }
}

// First `key: value` line of a pointer file (quotes and a trailing comment stripped).
function pointerValue(file, key) {
  let t; try { t = fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
  const m = t.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  return m ? m[1].replace(/[ \t]+#.*$/, '').trim().replace(/^["']|["']$/g, '') : '';
}
// Never print credentials, even if a pointer file holds a URL with user:pass@.
const cleanUrl = (u) => String(u || '').replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@]*@/, '$1');

// The error for a pointer that names a store this machine does not have. Nothing is cloned or registered for the user.
function storeProblem(id, ctx) {
  const url = cleanUrl(pointerValue(path.join(CODE_ROOT, 'openspec/config.yaml'), 'store_remote'));
  const list = openspecJson(['store', 'list', '--json'], CODE_ROOT, true);
  const reg = !list.missing && Array.isArray(list.stores) ? list.stores.find((x) => x.id === id) : null;
  const L = [];
  if (reg) {
    L.push(`OpenSpec store '${id}' is registered on this machine (${reg.root}), but that folder is missing or is not a usable OpenSpec store.`);
    const cj = ctx && (ctx.json || ctx); const st = cj && Array.isArray(cj.status) && cj.status[0];
    if (st && st.message) L.push(`  openspec says: ${st.message.replace(/^Declared in [^:]*: /, '')}`);
    L.push(`  Fix: run \`openspec store doctor ${id}\` to see what is wrong. If the folder was moved or deleted, clone the store again:`,
      `    git clone ${url || '<store repo url>'} <dir>`, `    openspec store unregister ${id}   (forgets the old registration only; no files are deleted)`, '    openspec store register <dir>');
  } else {
    L.push(`OpenSpec store '${id}' is not registered on this machine.`,
      `  This repo's openspec/config.yaml says \`store: ${id}\`. That is a pointer to a folder registered on this machine, not a URL: the specs, changes`,
      '  and ADRs live in a separate store repo, which has to be cloned here and registered once (nothing is cloned for you):');
    if (list.missing) L.push('  (the `openspec` CLI is not installed or not on PATH here: install it first)');
    L.push(`    1. git clone ${url || '<store repo url>'} <dir>${url ? '' : '        (ask whoever set up the store for the URL)'}`, '    2. openspec store register <dir>', '    3. run this command again');
    if (url) L.push(`  (the clone URL comes from \`store_remote:\` in openspec/config.yaml)`);
  }
  L.push(`  Or, for one run, point at a clone you already have: --root <dir>, or --store <other registered id> (\`openspec store list\`).`);
  return L.join('\n');
}

function resolveRoot(o) {
  if (o.root) return o.root;
  if (process.env.OPENSPEC_ROOT) return process.env.OPENSPEC_ROOT;
  if (!o.store && (fs.existsSync(path.join(CODE_ROOT, 'openspec/changes')) || fs.existsSync(path.join(CODE_ROOT, 'openspec/specs')))) return CODE_ROOT;
  const ws = path.join(CODE_ROOT, 'openspec/workspace.yaml');
  if (!o.store && fs.existsSync(ws)) {
    const m = fs.readFileSync(ws, 'utf8').match(/^specs:[ \t]*["']?([^"'#\n]+?)["']?[ \t]*(#.*)?$/m);
    if (m) {
      const dir = path.resolve(CODE_ROOT, m[1].trim());
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        const url = cleanUrl(pointerValue(ws, 'specs_remote'));
        die([`the specs repo is missing: ${dir}`,
          `  openspec/workspace.yaml says \`specs: ${m[1].trim()}\`, a folder relative to this repo that holds the OpenSpec files (specs, changes, ADRs).`,
          `  Clone the specs repo to ${dir} (relative to this repo: ${m[1].trim()}); nothing is cloned for you:`,
          `    git clone ${url || '<specs repo url>'} ${dir}${url ? '' : '        (ask whoever set it up for the URL)'}`,
          ...(url ? ['  (the clone URL comes from `specs_remote:` in openspec/workspace.yaml)'] : []),
          '  Or, for one run, pass --root <dir> of a clone you already have.'].join('\n'));
      }
      return dir;
    }
  }
  const cfgStore = pointerValue(path.join(CODE_ROOT, 'openspec/config.yaml'), 'store');
  const id = o.store || cfgStore;
  const ctx = openspecJson(o.store ? ['context', '--json', '--store', o.store] : ['context', '--json'], CODE_ROOT, !!id);
  if (ctx.root && ctx.root.path) return ctx.root.path;
  if (id) die(storeProblem(id, ctx));
  die('cannot find the OpenSpec root: run from a repo with openspec/changes, or with openspec/workspace.yaml `specs: <path>`, or openspec/config.yaml `store: <id>`; or pass --root/--store');
}

// ---------- tasks ----------
/** The file and 1-based line of every apply-JSON task (see Q.resolveTaskLines: OpenSpec 1.7.x omits `line` and `sourcePath`). Refuses when a task cannot be placed. */
function taskLocations(tasks, files) {
  try { return Q.resolveTaskLines(tasks, files); } catch (e) { return die(e.message); }
}

function applyInstructions(root, change) {
  const j = openspecJson(['instructions', 'apply', '--change', change, '--json'], root);
  if (j.error) die(`openspec instructions apply failed: ${j.error}`);
  if (!Array.isArray(j.tasks)) die('openspec instructions apply returned no task list (is the tasks artifact created?)');
  return j;
}

/** Checkbox lines OpenSpec counts but a human would not: inside ``` / ~~~ fences, or nested under another item. */
function ambiguousLines(file) {
  const out = []; let fence = null;
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; return; }
    if (!/^\s*[-*+]\s+\[[ xX]\]\s/.test(line)) return;
    if (fence) out.push({ line: i + 1, kind: 'fenced', text: line.trim() });
    else if (/^\s+/.test(line)) out.push({ line: i + 1, kind: 'nested', text: line.trim() });
  });
  return out;
}

function taskFiles(j) {
  const files = [...new Set(j.tasks.map((t) => t.sourcePath).filter(Boolean))];
  if (!files.length && j.contextFiles && j.contextFiles.tasks) files.push(...j.contextFiles.tasks);
  if (!files.length && j.changeDir && fs.existsSync(path.join(j.changeDir, 'tasks.md'))) files.push(path.join(j.changeDir, 'tasks.md'));
  return files;
}

/** The indented detail lines under the task's checkbox line (1-based `line`). */
function details(text, line) {
  const lines = text.split('\n'); const out = [];
  for (let i = line; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*$/.test(l)) { if (out.length) break; continue; }
    if (!/^\s+/.test(l) || /^\s*[-*+]\s+\[[ xX]\]\s/.test(l)) break;
    out.push(l.trim().replace(/^[-*+]\s+/, ''));
  }
  return out;
}

function doneWhenCmd(detailLines) {
  const d = detailLines.find((l) => /^Done when:/i.test(l));
  if (!d) return { line: null, cmd: null };
  const m = d.match(/`([^`]+)`/);
  return { line: d, cmd: m ? m[1] : null };
}

/**
 * Config files that may define the project commands and `visual:`, highest priority first: the code repo's own
 * pointer file (openspec/config.yaml with `store: <id>`, or openspec/workspace.yaml with `specs: <path>`), then the
 * root's openspec/config.yaml. Only in a workspace layout (root is not the code repo); several code repos share one
 * root, so each repo overrides the root's defaults per key. The last entry is always the root's config.
 */
function configFiles(root) {
  const out = [];
  let same = false; try { same = fs.realpathSync(root) === CODE_ROOT; } catch (e) { /* missing root: nothing to compare */ }
  if (!same) for (const n of ['config.yaml', 'workspace.yaml']) { const f = path.join(CODE_ROOT, 'openspec', n); if (fs.existsSync(f)) out.push(f); }
  out.push(path.join(root, 'openspec/config.yaml'));
  return out;
}
/** `- <label>: <cmd>` in one file: { cmd, source, state: set | none | placeholder | absent }. `all`: every line counts (test command). */
function lineCmd(cfg, label, all) {
  if (!fs.existsSync(cfg)) return { cmd: null, source: cfg, state: 'absent' };
  let seen = false;
  for (const m of fs.readFileSync(cfg, 'utf8').matchAll(new RegExp(`^\\s*-?\\s*${label}:\\s*(.*)$`, 'gmi'))) {
    seen = true;
    let c = m[1].trim(); const bt = c.match(/^`([^`]+)`/); if (bt) c = bt[1];
    if (/^(none|off|n\/a)?$/i.test(c) && (c || !all)) return { cmd: null, source: cfg, state: 'none' };
    if (c && !/^<.*>$/.test(c) && !/fill in/i.test(c)) return { cmd: c, source: cfg, state: 'set' };
    if (!all) return { cmd: null, source: cfg, state: 'placeholder' };
  }
  return { cmd: null, source: cfg, state: seen ? 'placeholder' : 'absent' };
}
/** The project test command: { cmd, source, state: set | none | placeholder | absent }. */
function testCmdInfo(o, root) {
  if (o.testCmd !== undefined) return { cmd: o.testCmd || null, source: '--test-cmd', state: o.testCmd ? 'set' : 'none' };
  if (process.env.SPEC_TEST_CMD !== undefined) return { cmd: process.env.SPEC_TEST_CMD || null, source: 'SPEC_TEST_CMD', state: process.env.SPEC_TEST_CMD ? 'set' : 'none' };
  const files = configFiles(root);
  for (const cfg of files) { const r = lineCmd(cfg, 'Test command', true); if (r.state !== 'absent') return r; } // a <fill in> in a repo's own file stops the lookup: it must not run another repo's command
  return { cmd: null, source: files[files.length - 1], state: 'absent' };
}
/** `- Test run: each task` (default: the project tests run at the checks `Check level` picks) or `- Test run: finish` (only `finish` runs them; a task's own Done when still runs at its check). SPEC_TEST_RUN overrides. */
function testRunMode(root) {
  const v = process.env.SPEC_TEST_RUN !== undefined ? process.env.SPEC_TEST_RUN : (() => { for (const cfg of configFiles(root)) { const m = fs.existsSync(cfg) && fs.readFileSync(cfg, 'utf8').match(/^\s*-?\s*Test run:\s*(.*)$/mi); if (m) return m[1]; } return ''; })();
  return /^\s*(finish|at finish|finish only)\s*$/i.test(v) ? 'finish' : 'each';
}
/**
 * `- Check level: targeted | group | task | finish` (SPEC_CHECK_LEVEL overrides). targeted (default): every check runs the task's
 * targeted tests; typecheck and lint run at the check that ends a task group (and a review task); the full test suite runs at
 * `finish` and at a review task. group: the full suite, typecheck and lint at the check that ends a group. task: all three at every
 * check. finish: none at `check`. `finish` always runs them all. A task's own `Done when:` always runs at its check.
 */
function checkLevel(root) {
  const v = process.env.SPEC_CHECK_LEVEL !== undefined ? process.env.SPEC_CHECK_LEVEL : (() => { for (const cfg of configFiles(root)) { const m = fs.existsSync(cfg) && fs.readFileSync(cfg, 'utf8').match(/^\s*-?\s*Check level:\s*(.*)$/mi); if (m) return m[1]; } return ''; })();
  if (/^\s*(finish|at finish|finish[- ]only)\s*$/i.test(v)) return 'finish';
  if (/^\s*(task|per[- ]task|each task)\s*$/i.test(v)) return 'task';
  return /^\s*(group|per[- ]group)\s*$/i.test(v) ? 'group' : 'targeted';
}
/** True when no other task of the group(s) the checked tasks belong to is still open (a lookup that fails counts as the end: the commands run). */
function endsGroup(state) {
  const mem = membersOf(state); const cache = new Map();
  for (const m of mem) {
    if (!m.file || !m.line || !fs.existsSync(m.file)) return true;
    if (!cache.has(m.file)) cache.set(m.file, Q.parsePlan(fs.readFileSync(m.file, 'utf8')));
    const g = cache.get(m.file).groups.find((x) => x.tasks.some((t) => t.line === m.line));
    if (!g) return true;
    if (g.tasks.some((t) => !t.done && !mem.some((y) => y.file === m.file && y.line === t.line))) return false;
  }
  return true;
}
/** Why the project commands are left to `finish` at this check (null: they run). */
function deferReason(root, state) {
  const lvl = checkLevel(root);
  if (lvl === 'task' || Q.isReviewTask(state.task.label, state.task.title)) return null;
  if (lvl === 'finish') return 'Check level: finish (runs once, at finish)';
  return endsGroup(state) ? null : `Check level: ${lvl} (runs when the last task of the group is checked)`;
}
// ---------- targeted tests: what `check` runs by default instead of the full suite ----------
/** `- Targeted test command: <template with {files} or {dirs}>` (SPEC_TARGETED_TEST_CMD overrides; none: no targeted tests); else a template from the test command. */
function targetedCmdInfo(root, testCmd) {
  const env = process.env.SPEC_TARGETED_TEST_CMD;
  if (env !== undefined) return env ? { tpl: env, source: 'SPEC_TARGETED_TEST_CMD' } : { tpl: null, source: 'SPEC_TARGETED_TEST_CMD', why: 'SPEC_TARGETED_TEST_CMD is empty' };
  for (const cfg of configFiles(root)) {
    const r = lineCmd(cfg, 'Targeted test command', false);
    if (r.state === 'set') return { tpl: r.cmd, source: cfg };
    if (r.state === 'none') return { tpl: null, source: cfg, why: 'Targeted test command: none' };
  }
  const t = TP.targetedTemplate(testCmd, (name) => { const p = RS.readJson(path.join(CODE_ROOT, 'package.json')); return p && p.scripts ? p.scripts[name] : null; });
  return t ? { tpl: t, source: 'test command' } : { tpl: null, source: null, why: `no targeted test command is known for \`${testCmd}\` (set "- Targeted test command: \`<runner> {files}\`" in openspec/config.yaml)` };
}
const shq = (f) => (/^[\w./@:+-]+$/.test(f) ? f : `'${f.replace(/'/g, "'\\''")}'`);
/** The tests this check targets: test files changed since the change began, tests tagged with the task's scenarios, tests named after its source files. */
function targetedTests(root, changeDir, state, testCmd) {
  const info = targetedCmdInfo(root, testCmd);
  if (!info.tpl) return { cmd: null, why: info.why, files: [] };
  const all = Q.listTestFiles(CODE_ROOT);
  const changed = changedTestFiles(changeBase(root, path.basename(changeDir))) || [];
  const scens = Q.specScenarios(path.join(changeDir, 'specs')); const refs = specRefsOf(state, scens);
  const ids = new Set([...refs.explicit, ...refs.implicit].map((x) => x.id));
  const tags = ids.size ? Q.traceTags(all, CODE_ROOT) : new Map();
  const tagged = [...ids].flatMap((id) => tags.get(id) || []);
  const sources = [...new Set([...membersOf(state).flatMap((m) => filesOf(m.details || [])), ...(changedFiles() || [])])];
  const mapped = TP.testsFor(sources, all);
  const files = [...new Set([...changed, ...tagged, ...mapped])].filter((f) => fs.existsSync(path.join(CODE_ROOT, f))).sort();
  const counts = { changed: changed.length, tagged: new Set(tagged).size, named_after_sources: mapped.length };
  if (!files.length) return { cmd: null, why: 'no test file targets this task (none changed, tagged with its scenarios or named after its files); the full suite runs at finish', files, counts };
  const dirs = [...new Set(files.map((f) => `./${path.posix.dirname(f)}`))];
  return { cmd: info.tpl.replace('{files}', files.map(shq).join(' ')).replace('{dirs}', dirs.map(shq).join(' ')), tpl: info.tpl, source: info.source, files, counts };
}
function testCmdProblem(info) {
  if (info.state === 'placeholder') return `the project test command in ${info.source} is still the <fill in> placeholder, so no task could be checked against the project's tests. Set "- Test command: \`<command>\`" in its context (e.g. \`npm test\`, \`pytest\`), or "- Test command: none" to opt out, or pass --test-cmd.`;
  if (info.state === 'absent') return `no "Test command:" line in ${info.source}. Add "- Test command: \`<command>\`" to its context (or "- Test command: none"), or pass --test-cmd.`;
  return null;
}

/**
 * Extra check commands from the config context (the installer detects them): `- Typecheck command: \`...\`` and
 * `- Lint command: \`...\``. $SPEC_TYPECHECK_CMD / $SPEC_LINT_CMD override ("" disables). Unlike the test command a
 * missing or <fill in> value does not refuse; it is skipped with a warning.
 */
const EXTRA_CMDS = [{ name: 'typecheck', label: 'Typecheck command', env: 'SPEC_TYPECHECK_CMD' }, { name: 'lint', label: 'Lint command', env: 'SPEC_LINT_CMD' }];
function extraCmdInfo(root, x) {
  if (process.env[x.env] !== undefined) return { name: x.name, cmd: process.env[x.env] || null, source: x.env, state: process.env[x.env] ? 'set' : 'none' };
  const files = configFiles(root);
  for (const cfg of files) { const r = lineCmd(cfg, x.label, false); if (r.state !== 'absent') return { name: x.name, ...r }; }
  return { name: x.name, cmd: null, source: files[files.length - 1], state: 'absent' };
}
/** The commands a `Done when:` line runs, split on && ; || (so `npm test && npm run typecheck` covers both). */
function doneWhenParts(cmd) { return cmd ? cmd.split(/\s*(?:&&|\|\||;)\s*/).map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean) : []; }
const norm = (c) => String(c || '').trim().replace(/\s+/g, ' ');

// ---------- trace and test quality (quality.cjs) ----------
function gitList(args) { const r = RS.timed(`git ${args[0]}`, () => spawnSync('git', args, { cwd: CODE_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })); return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : null; }
/** Commit the change's first apply run started from (recorded once by `next`). */
function changeBase(root, change) { const f = path.join(runsDir(root, change), 'base'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() || null : null; }
function recordBase(root, change) {
  const f = path.join(runsDir(root, change), 'base'); if (fs.existsSync(f)) return;
  const h = gitList(['rev-parse', 'HEAD']); if (h && h[0]) fs.writeFileSync(f, h[0] + '\n');
}
/** Test files changed since `base` (committed or not); null without git. */
function changedTestFiles(base) {
  const now = changedFiles(); if (!now) return null;
  const since = base ? gitList(['diff', '--name-only', base, '--']) || [] : [];
  return [...new Set([...since, ...now])].filter((f) => Q.isTestFile(f) && fs.existsSync(path.join(CODE_ROOT, f)));
}
/** Token lint over changed UI files (design-contract.cjs): arbitrary values / raw hex equal to a project token fail;
 *  other arbitrary values, raw hex, inline px/hex and stock palette classes warn unless design-map.md records them as
 *  gaps. Runs when the change has a design map or the project defines tokens; null when there is nothing to check. */
function designTokenLint(changeDir, files) {
  const ui = (files || []).filter((f) => Q.isUiFile(f) && !Q.isTestPath(f) && fs.existsSync(path.join(CODE_ROOT, f)));
  if (!ui.length) return null;
  const map = DC.readDesignMap(changeDir); const ds = DC.discover(CODE_ROOT);
  if (!map && !ds.tokens.length) return null;
  return { files: ui.length, ...DC.tokenLint(CODE_ROOT, ui, ds, map) };
}
function addTokenLint(tl, checks, failures, warnings) {
  if (!tl) return;
  checks.push({ check: 'design_tokens', ok: !tl.errors.length, files: tl.files, ...tl.counts, errors: tl.errors.length, warnings: tl.warnings.length });
  if (tl.errors.length) failures.push(`UI code hard-codes values the project has tokens for:\n${tl.errors.map((x) => '- ' + x).join('\n')}\nBuild with the project's tokens and components (design-map.md; \`node openspec/scripts/verify-task.cjs design-system\` lists them).`);
  for (const w of tl.warnings) warnings.push(`design tokens: ${w}`);
}
/** Source-text rule over the given test files: { bad: [text], allowed: [text] }. */
function sourceTextCheck(files) {
  const bad = []; const allowed = [];
  for (const f of files) {
    const r = Q.sourceTextFindings(path.join(CODE_ROOT, f), f);
    if (!r.findings.length) continue;
    if (r.optOut) allowed.push(`${f}: source-text-ok (${r.optOut})`); else bad.push(...r.findings.map((x) => x.text));
  }
  return { bad, allowed };
}
function traceFor(root, changeDir, cfg) {
  const scens = Q.specScenarios(path.join(changeDir, 'specs'));
  const tags = Q.traceTags(Q.listTestFiles(CODE_ROOT), CODE_ROOT);
  return { scens, tags, res: Q.trace(scens, tags, { visualCovers: !cfg.off }) };
}
const TAG_HELP = 'Put the scenario id in square brackets in the title of the test that proves it, e.g. it(\'[list-search/zero-matches] shows the empty state\') or def test_zero_matches(): with a "[list-search/zero-matches]" docstring; the id is <capability>/<scenario name in kebab-case>.';

// ---------- visual ----------
function visualConfig(root) { return VC.readLayers(configFiles(root)); }
function changeScenarios(changeDir) { return VC.scenariosIn(path.join(changeDir, 'specs')); }
/** `Visual:` detail line -> { all, none, ids[] } (ids as written; resolved later). */
function visualRefs(detailLines) {
  const d = detailLines.find((l) => /^Visual:/i.test(l)); if (!d) return { line: null, all: false, ids: [] };
  const v = d.replace(/^Visual:\s*/i, '').replace(/`/g, '').trim();
  if (/^(none|-|n\/a)?$/i.test(v)) return { line: d, all: false, ids: [] };
  if (/^all\b/i.test(v)) return { line: d, all: true, ids: [] };
  return { line: d, all: false, ids: v.split(/\s*[,;]\s*/).map((x) => x.trim()).filter(Boolean) };
}
/** Resolve `Visual:` references against the change's scenarios: by id, by slug, or by scenario name. */
function resolveRefs(refs, scens) {
  if (refs.all) return { found: scens.slice(), unknown: [] };
  const found = []; const unknown = [];
  for (const r of refs.ids) {
    const k = r.toLowerCase(); const sl = VC.slug(r.includes('/') ? r.split('/').pop() : r);
    const hit = scens.find((s) => s.id.toLowerCase() === k) || scens.find((s) => s.id.endsWith('/' + sl) && (!r.includes('/') || s.capability === r.split('/')[0]));
    if (hit) { if (!found.includes(hit)) found.push(hit); } else unknown.push(r);
  }
  return { found, unknown };
}
function filesOf(detailLines) {
  const d = detailLines.find((l) => /^Files:/i.test(l)); if (!d) return [];
  return d.replace(/^Files:\s*/i, '').split(/[\s,;]+/).map((x) => x.replace(/[`()]/g, '')).filter((x) => /[./]/.test(x));
}
// One `git status` per phase: the answer only changes when a project command has run (runNamed drops it).
let changedMemo;
function changedFiles() {
  if (changedMemo !== undefined) return changedMemo;
  const r = RS.timed('git status', () => spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: CODE_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  if (r.status !== 0) return (changedMemo = null);
  return (changedMemo = r.stdout.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '')).filter((f) => !f.startsWith('openspec/')));
}
// ---------- planning path (quality.cjs planPath): a fast change that leaves its scope is upgraded to the full path ----------
const SCOPE_MAX_LINES = 150;
const upgradeFile = (changeDir) => path.join(changeDir, '..', '..', '.apply-runs', path.basename(changeDir), 'upgrade.json');
const readUpgrade = (changeDir) => RS.readJson(upgradeFile(changeDir));
/** What the code changed since the run's base commit has outgrown a fast change: a sensitive path, UI files, more than SCOPE_MAX_LINES lines. */
function scopeReasons(root, change) {
  const base = changeBase(root, change); const now = changedFiles(); if (!base || !now) return [];
  const prod = (f) => !f.startsWith('openspec/') && !Q.isTestPath(f) && fs.existsSync(path.join(CODE_ROOT, f));
  const files = [...new Set([...(gitList(['diff', '--name-only', base, '--']) || []), ...now])].filter(prod);
  const reasons = [];
  const sens = files.filter(Q.isSensitivePath); if (sens.length) reasons.push(`edited a sensitive path: ${sens.join(', ')}`);
  const ui = files.filter((f) => Q.isUiFile(f)); if (ui.length) reasons.push(`changed UI files: ${ui.join(', ')}`);
  const tracked = new Set(gitList(['ls-files']) || []);
  let lines = 0;
  for (const l of gitList(['diff', '--numstat', base, '--']) || []) { const [a, d, f] = l.split('\t'); if (prod(f)) lines += (Number(a) || 0) + (Number(d) || 0); }
  let since = 0; try { since = fs.statSync(path.join(runsDir(root, change), 'base')).mtimeMs; } catch (e) { /* no run yet */ }
  for (const f of files.filter((x) => !tracked.has(x))) lines += textLines(path.join(CODE_ROOT, f), since);
  if (lines > SCOPE_MAX_LINES) reasons.push(`${lines} changed lines (a fast change allows ${SCOPE_MAX_LINES})`);
  return reasons;
}
/** Lines of an untracked text file written since `since` (the change's first run); 0 for older files and data (over 512 KB, or
 * binary): a database or upload directory next to the code is not an edit. */
function textLines(f, since) {
  try {
    const st = fs.statSync(f); if (st.size > 512 * 1024 || st.mtimeMs < since) return 0;
    const b = fs.readFileSync(f); return b.subarray(0, 8000).includes(0) ? 0 : b.toString('utf8').split('\n').length;
  } catch (e) { return 0; }
}
/** After a task passed: a change on the fast path whose edits left its scope is upgraded (upgrade.json); returns the new reasons. */
function checkScope(root, change, changeDir) {
  if (readUpgrade(changeDir)) return [];
  const f = Q.sizeFacts(changeDir);
  if (!f.has_proposal || f.is_slice || f.spec_only || Q.planPath(f).path !== 'fast') return [];
  const reasons = scopeReasons(root, change); if (!reasons.length) return [];
  RS.writeJson(upgradeFile(changeDir), { at: new Date().toISOString(), reasons });
  return reasons;
}
function visualLint(root, changeDir, tasksFiles) {
  const scens = changeScenarios(changeDir);
  const problems = VC.lintScenarios(scens, changeDir, root, visualConfig(root)).map((p) => ({ ...p, severity: 'error' }));
  const used = new Set(); let anyAll = false;
  for (const f of tasksFiles) {
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n'); const tl = [];
    lines.forEach((l, i) => {
      if (!/^\s*[-*+]\s+\[[ xX]\]\s/.test(l)) return;
      const det = details(lines.join('\n'), i + 1);
      const refs = visualRefs(det);
      if (refs.all) anyAll = true;
      const r = resolveRefs(refs, scens);
      tl.push({ line: i + 1, label: (l.match(/\[[ xX]\]\s+(\d+\.(?:\d+|[A-Za-z]+))/) || [])[1] || l.trim().slice(6, 40), review: /\.R\b|code review/i.test(l), text: [l, ...det.filter((x) => !/^Visual:/i.test(x))].join(' '), files: filesOf(det), found: refs.all ? [] : r.found });
      r.found.forEach((s) => used.add(s.id));
      for (const u of r.unknown) problems.push({ file: f, line: i + 1, kind: 'visual-ref', severity: 'error', text: `${path.basename(f)}:${i + 1}: Visual: names "${u}", which is not a visual scenario of this change (known: ${scens.map((s) => s.id).join(', ') || 'none'})` });
    });
    // A task may name a visual scenario only when the elements it checks exist after that task: a key whose test id
    // only a LATER task mentions (or whose component only a later task's Files: creates) makes the check fail or block.
    const testids = (sel) => [...String(sel).matchAll(/data-testid\s*=\s*["']?([\w-]+)/g)].map((m) => m[1]);
    tl.forEach((t, i) => {
      if (t.review) return;
      const upto = tl.slice(0, i + 1).filter((x) => !x.review); const later = tl.slice(i + 1).filter((x) => !x.review);
      for (const sc of t.found) {
        const ids = [...new Set([...sc.keys, ...sc.states.flatMap((x) => x.keys)].flatMap(testids))];
        const lateIds = ids.filter((id) => later.some((x) => x.text.includes(id)) && !upto.some((x) => x.text.includes(id)));
        if (lateIds.length) { const by = later.find((x) => lateIds.some((id) => x.text.includes(id))); problems.push({ file: f, line: t.line, kind: 'visual-order', severity: 'error', text: `${path.basename(f)}:${t.line}: task ${t.label} names visual scenario ${sc.id}, which checks ${lateIds.map((x) => `[data-testid="${x}"]`).join(', ')}; only the later task ${by.label} mentions ${lateIds.length > 1 ? 'them' : 'it'}, so the check would fail (or block) here. Name ${sc.id} in the Visual: line of the task that completes it (${by.label}), or move those elements into ${t.label}` }); continue; }
        const comp = sc.component && sc.component.toLowerCase();
        if (comp && !upto.some((x) => x.files.some((fl) => path.basename(fl).toLowerCase().startsWith(comp))) && later.some((x) => x.files.some((fl) => path.basename(fl).toLowerCase().startsWith(comp)))) problems.push({ file: f, line: t.line, kind: 'visual-order', severity: 'info', text: `${path.basename(f)}:${t.line}: task ${t.label} names visual scenario ${sc.id} (component: ${sc.component}), but only a later task's Files: touches ${sc.component}; name the scenario from that task` });
      }
    });
  }
  // Design references: every referenced element has a design-map.md row with its source; expect: syntax and tokens.
  problems.push(...DC.lintDesign(scens, changeDir, root, CODE_ROOT));
  problems.push(...VC.expectScopeLint(scens, root));
  for (const s of scens) if (!s.component && !s.errors.length) problems.push({ file: s.file, line: s.line, kind: 'visual-component', severity: 'info', scenario: s.id, text: `${path.relative(root, s.file)}:${s.line}: visual scenario ${s.id} has no component: line, so no task may change it. Add "component: <file name>" so a task that lists that file in Files: may change it` });
  if (!anyAll) for (const s of scens) if (!used.has(s.id)) problems.push({ file: s.file, line: s.line, kind: 'visual-coverage', severity: 'warning', scenario: s.id, text: `${path.relative(root, s.file)}:${s.line}: visual scenario ${s.id} is not named by any task's Visual: line, so no task checks it` });
  return { scenarios: scens, problems };
}

// ---------- run log ----------
function runsDir(root, change) {
  const base = path.join(root, 'openspec/.apply-runs');
  fs.mkdirSync(base, { recursive: true });
  const gi = path.join(base, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  const d = path.join(base, change); fs.mkdirSync(d, { recursive: true }); return d;
}
function stamp() { return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); }
function currentRun(root, change, create) {
  const d = runsDir(root, change); const ptr = path.join(d, 'current');
  if (fs.existsSync(ptr)) { const id = fs.readFileSync(ptr, 'utf8').trim(); if (id && fs.existsSync(path.join(d, id))) return path.join(d, id); }
  if (!create) return null;
  let id = `${stamp()}-${process.pid}`; let n = 0;
  while (fs.existsSync(path.join(d, id))) id = `${stamp()}-${process.pid}-${++n}`;
  fs.mkdirSync(path.join(d, id, 'pre'), { recursive: true });
  const now = new Date().toISOString();
  RS.writeJson(path.join(d, id, 'run.json'), { id, ...RS.identity(o, CODE_ROOT), started: now, last_activity: now, ...RS.fingerprint(CODE_ROOT, false) });
  fs.writeFileSync(ptr, id + '\n');
  RUN_STATUS = `new ${RS.describeRun(RS.readJson(path.join(d, id, 'run.json')), Date.now(), true)}`; process.stderr.write(`verify-task: ${RUN_STATUS}\n`);
  tl({ event: 'run-start', run: id, summary: `run started (${o.cmd})` });
  return path.join(d, id);
}
const readState = (run) => JSON.parse(fs.readFileSync(path.join(run, 'state.json'), 'utf8'));
const writeState = (run, s) => fs.writeFileSync(path.join(run, 'state.json'), JSON.stringify(s, null, 2) + '\n');
const logMetric = (run, rec) => fs.appendFileSync(path.join(run, 'metrics.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n');

/**
 * Tasks whose tick a `check` (or `review`) passed, per change, across runs: { baseline: [descriptions ticked before the
 * verifier first ran], passed: { description: { at, run } } }. `next` refuses while tasks.md has a tick that is in
 * neither: a re-ticked task must be checked, not skipped.
 */
const ledgerFile = (root, change) => path.join(runsDir(root, change), 'verified.json');
function readLedger(root, change, tasks) {
  const f = ledgerFile(root, change);
  if (fs.existsSync(f)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { /* rebuilt below */ } }
  const l = { baseline: (tasks || []).filter((t) => t.done).map((t) => t.description), passed: {} };
  fs.writeFileSync(f, JSON.stringify(l, null, 2) + '\n'); return l;
}
function recordPass(root, change, run, task) {
  const l = readLedger(root, change, []); const rec = RS.readJson(path.join(run, 'run.json')) || {}; const fp = RS.fingerprint(CODE_ROOT);
  l.passed[task.description] = { at: new Date().toISOString(), run: path.basename(run), session: rec.session || null, ...fp, worktree: CODE_ROOT, files_hash: RS.filesHash(CODE_ROOT, filesOf(task.details || [])) };
  fs.writeFileSync(ledgerFile(root, change), JSON.stringify(l, null, 2) + '\n');
}
const isVerified = (l, d) => l.baseline.includes(d) || Object.prototype.hasOwnProperty.call(l.passed, d);

/**
 * Before next, check, review and finish: take the change's lock (one live verify-task command per change) and, for the run the command
 * works on, refuse another session's or worktree's run unless --takeover (or it has been idle for 30 minutes), then record the activity.
 */
function guardRun(o) {
  const { root } = context(o);
  const dir = runsDir(root, o.change); const me = RS.identity(o, CODE_ROOT);
  const refuse = (result, text, extra) => { printJson({ result, ...extra, fix: text }); process.stderr.write(`verify-task: REFUSED: ${text}\n`); process.exit(EXIT.USAGE); };
  const lk = RS.acquireLock(dir, me, o.cmd, o.takeover);
  if (!lk.ok) {
    const h = lk.holder;
    refuse('busy', `another verify-task command is running on '${o.change}': \`${h.command}\` (pid ${h.pid}${h.session ? `, session ${h.session}` : ''}, started ${h.started}, last heartbeat ${RS.minutes(h.heartbeat)} min ago). Wait for it to end. Two commands on one change would overwrite each other's task snapshots. If its process is gone, rerun with --takeover.`, { holder: h });
  }
  const run = currentRun(root, o.change, false);
  const rec = run && RS.readJson(path.join(run, 'run.json'));
  if (!rec) return;
  const ow = RS.ownership(rec, me, Date.now());
  if (ow.foreign && !o.takeover && ow.idle < RS.IDLE_MIN) {
    refuse('run-owned', `the open run of '${o.change}' belongs to ${ow.otherSession ? `session ${rec.session}` : `the worktree ${rec.worktree}`}, not to ${ow.otherSession ? `your session ${me.session}` : `this worktree ${me.worktree}`}: ${RS.describeRun(rec)}. Another agent may be working on this change right now; stop, do not start a second run. If that run is dead, rerun with --takeover (it is also adopted automatically after ${RS.IDLE_MIN} idle minutes).`, { run: path.basename(run), owner: { session: rec.session, worktree: rec.worktree, branch: rec.branch, head: rec.head, started: rec.started, idle_minutes: ow.idle } });
  }
  const now = new Date().toISOString(); let status;
  if (ow.foreign) {
    logMetric(run, { event: 'takeover', from: { session: rec.session, worktree: rec.worktree, pid: rec.pid }, to: { session: me.session, worktree: me.worktree }, idle_minutes: ow.idle, why: o.takeover ? '--takeover' : `idle ${ow.idle} min` });
    status = `took over ${RS.describeRun(rec)} (${o.takeover ? '--takeover' : `idle ${ow.idle} min`})`;
    Object.assign(rec, { session: me.session, worktree: me.worktree, pid: me.pid, taken_over_at: now });
    tl({ event: 'takeover', run: path.basename(run), summary: status });
  } else status = `${ow.unknown ? 'resuming (the session of this run is unknown: pass --session or set SPEC_SESSION so that a second agent is refused)' : 'own'} ${RS.describeRun(rec)}`;
  RS.writeJson(path.join(run, 'run.json'), { ...rec, last_activity: now });
  RUN_STATUS = status; process.stderr.write(`verify-task: ${status}\n`);
}

/** Ticked tasks whose passing check was recorded on another branch or checkout (not in this history, other files): description -> why. */
function foreignRecords(tasks, ledger, files) {
  const out = new Map(); if (!tasks.some((t) => t.done && ledger.passed[t.description])) return out;
  const fp = RS.fingerprint(CODE_ROOT); const at = taskLocations(tasks, files);
  for (const [i, t] of tasks.entries()) {
    const rec = t.done && ledger.passed[t.description]; if (!rec) continue;
    const det = details(fs.readFileSync(at[i].file, 'utf8'), at[i].line);
    const r = RS.judgeRecord(CODE_ROOT, rec, { ...fp, files_hash: RS.filesHash(CODE_ROOT, filesOf(det)) });
    if (r.state === 'foreign') out.set(t.description, r.note);
  }
  return out;
}

function closeRun(root, change, run, reason) {
  logMetric(run, { event: 'run-end', reason });
  const ptr = path.join(runsDir(root, change), 'current'); if (fs.existsSync(ptr)) fs.unlinkSync(ptr);
}

// ---------- command execution with a hard timeout (kills the whole process group) ----------
const say = (m) => process.stderr.write(`verify-task: ${m}\n`);
/** Runs `cmd`; with a label it says so on stderr when the command is still running after 3 s and every 15 s after that, and when it ends after 3 s or more. */
function runCmd(cmd, cwd, timeoutSec, label) {
  RS.forgetTrees(); // the command may edit files: hash again afterwards
  return new Promise((resolve) => {
    const t0 = Date.now(); let out = ''; let timedOut = false;
    const secs = () => Math.round((Date.now() - t0) / 1000);
    let beat = null, nextBeat = 3000;
    if (label) { const tick = () => { say(`${label}: still running after ${secs()}s (limit ${timeoutSec}s): ${cmd.length > 90 ? cmd.slice(0, 87) + '...' : cmd}`); nextBeat = 15000; beat = setTimeout(tick, nextBeat); if (beat.unref) beat.unref(); }; beat = setTimeout(tick, nextBeat); if (beat.unref) beat.unref(); }
    const child = spawn('sh', ['-c', cmd], { cwd, detached: process.platform !== 'win32', env: { ...process.env, OPENSPEC_TELEMETRY: '0' } });
    let all = ''; const add = (b) => { out += b; if (out.length > 4 * TAIL) out = out.slice(-2 * TAIL); if (all.length < 4 * 1024 * 1024) all += b; };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill('SIGKILL'); } catch (e2) { /* gone */ } }
    }, timeoutSec * 1000);
    child.on('close', (code, signal) => {
      clearTimeout(timer); if (beat) clearTimeout(beat);
      if (label && (Date.now() - t0 >= 3000 || timedOut)) say(`${label}: ${timedOut ? `killed after the ${timeoutSec}s limit` : `finished in ${secs()}s (exit ${code})`}`);
      resolve({ cmd, limit: timeoutSec, rc: timedOut ? 124 : (code === null ? 128 : code), signal, timedOut, seconds: (Date.now() - t0) / 1000, tail: out.slice(-TAIL), full: all });
    });
    child.on('error', (e) => { clearTimeout(timer); if (beat) clearTimeout(beat); resolve({ cmd, rc: 127, timedOut: false, seconds: 0, tail: String(e) }); });
  });
}

/** A project command (tests, typecheck, lint): a passing result for the same tree and command is reused, a failing one never is. */
async function runProject(o, root, cmd, cwd, name, treeKey) {
  const f = o.noCache || process.env.SPEC_NO_CACHE ? null : RS.cacheFile(runsDir(root, o.change), cwd, cmd, treeKey);
  const hit = f && RS.readJson(f);
  if (hit) return { ...hit, seconds: 0, cached: true };
  const r = await runCmd(cmd, cwd, timeoutFor(o, name), name);
  if (f && r.rc === 0) RS.cachePut(f, { cmd, rc: 0, tail: r.tail, full: r.full });
  return r;
}
const PROJECT_CMDS = new Set(['tests', 'typecheck', 'lint']);
/** `--timeout`, or SPEC_TIMEOUT_<NAME> (TESTS, TYPECHECK, LINT, DONE_WHEN, VALIDATE) for one command. */
function timeoutFor(o, name) {
  const v = process.env[`SPEC_TIMEOUT_${String(name).toUpperCase().replace(/[^A-Z]/g, '_')}`];
  return /^[1-9][0-9]*$/.test(v || '') ? Number(v) : o.timeout;
}
/** One command, timed, with live progress; a project command (tests, typecheck, lint) is answered from the cache of this tree when it passed there. */
async function runNamed(o, root, name, cmd, cwd, treeKey) {
  const r = await RS.timed(`${name}`, () => (PROJECT_CMDS.has(name) ? runProject(o, root, cmd, cwd, name, treeKey) : runCmd(cmd, cwd, timeoutFor(o, name), name)));
  if (!r.cached) changedMemo = undefined;
  return r;
}
/** The tree hash that keys the result cache, taken once before any command of this phase runs (null outside git or with --no-cache). */
const phaseTree = (o) => (o.noCache || process.env.SPEC_NO_CACHE ? null : RS.cacheTree(CODE_ROOT));

// ---------- commands ----------
function context(o) {
  const root = fs.realpathSync(resolveRoot(o));
  const changeDir = path.join(root, 'openspec/changes', o.change);
  if (!fs.existsSync(changeDir)) die(`change '${o.change}' not found under ${root}/openspec/changes`);
  return { root, changeDir };
}

function lintReport(files) {
  return files.flatMap((f) => (fs.existsSync(f) ? ambiguousLines(f).map((x) => ({ file: f, ...x })) : []));
}

/** Who started the run this command works on (set by guardRun / a new run); every verdict of next, check, review and finish carries it. */
let RUN_STATUS = null;
// The timeline (timeline.cjs): one event per verdict of next, check, review, finish and sync; run start, takeover, check and finish
// start, decisions and archive are recorded where they happen.
const T_START = Date.now();
let TL_DIR;
function tl(ev) {
  const oo = typeof o === 'undefined' ? null : o; if (!oo || !oo.change) return;
  if (TL_DIR === undefined) try { TL_DIR = runsDir(fs.realpathSync(resolveRoot(oo)), oo.change); } catch (e) { TL_DIR = null; }
  if (TL_DIR) TL.append(TL_DIR, { session: oo.session || process.env.SPEC_SESSION || null, ...ev });
}
const firstLines = (xs) => (xs || []).map((f) => String(f).split('\n')[0]);
function timelineOf(cmd, x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return;
  const seconds = Math.round(((typeof x.seconds === 'number' ? x.seconds * 1000 : Date.now() - T_START) / 1000) * 10) / 10;
  const task = typeof x.task === 'string' ? x.task : x.task && x.task.label;
  const fails = { failures: x.failures, output_tail: x.output_tail };
  if (cmd === 'next') {
    if (x.result === 'task') return tl({ event: 'next', ok: true, task, seconds, summary: `picked ${(x.batch || []).length > 1 ? x.batch.map((b) => b.label).join(', ') : `${task} ${x.task.title}`}`, details: { files: [].concat(x.task.details || []).join('\n').match(/[\w./-]+\.[a-z]{1,5}\b/g) } });
    return tl({ event: 'next', ok: x.result === 'complete', seconds, summary: x.result === 'complete' ? 'every task is ticked: finish is next' : `${x.result}${x.problem ? `: ${x.problem}` : ''}`, details: { failures: x.problems } });
  }
  if (cmd === 'check' || cmd === 'review') {
    if (x.visual && typeof x.visual === 'object' && !Array.isArray(x.visual)) tl({ event: 'visual', task, ok: !x.visual.defects && !x.visual.skipped, seconds: x.visual.seconds, summary: x.visual.skipped ? `visual check skipped: ${x.visual.skipped}` : `${(x.visual.scenarios || []).length} visual scenario(s), ${x.visual.defects || 0} defect(s), ${x.visual.area_images || 0} area image(s)`, details: { files: [x.visual.report, x.visual.dir].filter((f) => typeof f === 'string') } });
    if (x.result === 'review-pending') return tl({ event: 'review-packet', task, seconds, summary: 'visual review packet ready for an independent reviewer', details: { files: [x.review_prompt, x.dir].filter((f) => typeof f === 'string') } });
    const ok = x.result === 'passed';
    tl({ event: cmd, task, ok, seconds, summary: ok ? (cmd === 'review' ? 'visual review passed' : 'all checks passed') : `${x.result}${x.failures ? `: ${firstLines(x.failures)[0]}` : x.problem ? `: ${x.problem}` : ''}`, details: fails });
    if (ok) return tl({ event: 'tick', task, ok: true, summary: `ticked ${task}` });
    if (x.result === 'failed') tl({ event: 'fix-round', task, summary: `fix round ${x.attempt + 1} of ${x.max_attempts}` });
    return;
  }
  if (cmd === 'finish') return tl({ event: 'finish', ok: x.result === 'finished', seconds, summary: x.result === 'finished' ? 'change verified' : `${x.result}${x.failures ? `: ${firstLines(x.failures)[0]}` : x.problem ? `: ${x.problem}` : ''}`, details: fails });
  if (cmd === 'sync' || cmd === 'sync-check') return tl({ event: 'sync', ok: !!x.synced, seconds, summary: x.synced ? 'specs and code in sync' : `not synced: ${(x.problems || []).length} problem(s)`, details: { failures: x.problems } });
}
function printJson(x) {
  if (typeof o !== 'undefined' && o && ['next', 'check', 'review', 'finish', 'sync', 'sync-check'].includes(o.cmd) ) timelineOf(o.cmd, x);
  process.stdout.write(JSON.stringify(RUN_STATUS && x && typeof x === 'object' && !Array.isArray(x) && x.result ? { ...x, run_status: RUN_STATUS } : x, null, 2) + '\n'); }

function packetPrompt(p) {
  const rel = (f) => (p.openspec_root === CODE_ROOT ? path.relative(CODE_ROOT, f) || '.' : f);
  return [
    p.batch.length > 1 ? `Implement these ${p.batch.length} tasks, in order, of the OpenSpec change \`${p.change}\` (change directory: \`${rel(p.change_dir)}\`); the verifier checks them together after you reply.` : `Implement exactly ONE task of the OpenSpec change \`${p.change}\` (change directory: \`${rel(p.change_dir)}\`).`,
    ...p.batch.flatMap((b) => [`Task ${b.label}: ${b.title}`, ...b.details.map((d) => `  ${d}`)]),
    '',
    `Read first: ${p.read.map(rel).join(', ')}.`,
    p.earlier.length ? `Already done in this change: ${p.earlier.join('; ')}.` : '',
    p.attempt > 1 ? `This is attempt ${p.attempt} of ${p.max_attempts}. The previous attempt was rejected by the verifier:\n${p.last_failure}` : '',
    p.visual && p.visual.scenarios.length ? [
      `Visual scenarios for this task: ${p.visual.scenarios.join(', ')}. The verifier opens each scenario state at ${p.visual.viewports.join('/')}px and fails on console or page errors, failed requests, axe violations, sideways scrolling, missing/hidden/offscreen/overlapping key elements and broken images${p.visual.guards ? ", and on any change to OTHER declared scenarios outside this task's Files: (it compared them before you started)" : ''}. \`finish\` checks every other declared scenario against the state before the change. Then a reviewer compares before/after images of the affected areas with the scenario${p.visual.references.length ? ' and the design reference' : ''}.`,
      `Before you reply, run \`${p.visual.self_check}\`, fix every defect it lists, read its ARIA changes, and open the after images it lists to look at them yourself (${p.visual.references.length ? `compare with ${p.visual.references.join(', ')}` : 'compare with the scenario text'}).`,
    ].join('\n') : '',
    p.trace && (p.trace.scenarios.length || p.trace.requirement_level.length) ? `Tag the test that proves each scenario with its id in square brackets in the test title: ${[...p.trace.scenarios, ...p.trace.requirement_level].map((x) => `[${x}]`).join(', ')}${p.trace.requirement_level.length ? ` (those of ${p.trace.requirement_level.map((x) => `[${x}]`).join(', ')} that this task implements)` : ''}. The verifier fails the task when a scenario it names has no tagged test. Tests assert behaviour (results, rendered DOM), never source text: no \`?raw\` imports or readFileSync of source files.` : 'Tests assert behaviour (results, rendered DOM), never source text: no `?raw` imports or readFileSync of source files.',
    p.anchors && p.anchors.length ? `Code anchors: put a comment \`@spec <capability>/<requirement-slug>\` (any comment syntax) on the one function (or the few lines) that decides each requirement's observable behaviour, once per code path: whole function: once in its doc comment; part of a function: once on its own line directly above those lines; never on an import, constant, type, string or i18n table, getter, logging or plumbing line, never in another feature's file, never at the end of a code line or the top of a multi-function file, never because the code is merely used by or visible after the behaviour; a requirement with no distinct code of its own gets its test tag only. And the same marker (or a [capability/scenario-slug] test tag) in its test: ${p.anchors.map((x) => `@spec ${x}`).join(', ')}. The verifier rejects a marker that does not resolve and finish fails a requirement with no code anchor or no test anchor; you write only the comments; the verifier derives the index from them on demand (nothing to commit).` : '',
            p.read.some((f) => path.basename(f) === 'design-map.md') ? 'This change implements a design: build the UI with exactly what design-map.md names (project tokens, then components and their variants, framework defaults only where it says so). No new hex colours, px values or arbitrary classes (`p-[13px]`) unless the map lists them under Gaps; the verifier rejects hard-coded values that equal a project token, and the visual check measures its `expect:` lines.' : '',
    p.review_range ? `Code review range for the requesting-code-review skill: BASE_SHA=${p.review_range.base} HEAD_SHA=${p.review_range.head}. HEAD_SHA is a snapshot of the working tree with every uncommitted and untracked file; \`git diff BASE_SHA HEAD_SHA\` is the whole change. Use these two values; do not run git rev-parse or git merge-base for the range.` : '',
    p.warnings && p.warnings.length ? p.warnings.map((w) => `WARNING: ${w}`).join('\n') : '',
    'Do not edit tasks.md (the verifier ticks the task when its checks pass), specs or ADRs, and do not commit. If the task cannot be done as specified, write BLOCKED.md in the change directory.',
    'End your reply with one line: `STATUS: done`, `STATUS: failed` or `STATUS: blocked`.',
  ].filter(Boolean).join('\n');
}

async function cmdNext(o) {
  const { root, changeDir } = context(o);
  if (fs.existsSync(path.join(changeDir, 'BLOCKED.md'))) { printJson({ result: 'blocked', blocked_file: path.join(changeDir, 'BLOCKED.md') }); process.exit(EXIT.BLOCKED); }
  const j = applyInstructions(root, o.change);
  const files = taskFiles(j);
  const bad = lintReport(files);
  if (bad.length) { printJson({ result: 'ambiguous-tasks', problems: bad, fix: 'Move example checkboxes out of code fences and turn nested checkboxes into plain detail lines (`- Spec:` etc.), then rerun. Use /spec-fix if the plan must change.' }); process.exit(EXIT.USAGE); }
  const tinfo = testCmdInfo(o, root); const tprob = testCmdProblem(tinfo);
  if (tprob) { printJson({ result: 'config', problem: tprob }); process.stderr.write(`verify-task: REFUSED: ${tprob}\n`); process.exit(EXIT.USAGE); }
  const vl = visualLint(root, changeDir, files); const vbad = vl.problems.filter((p) => p.severity === 'error');
  if (vbad.length) { printJson({ result: 'visual-spec', problems: vbad, fix: 'Fix the ```visual blocks or Visual: lines with /spec-fix (specs and tasks are planning artifacts), then rerun.' }); process.exit(EXIT.USAGE); }
  const pbad = [...planProblems(files, changeDir), ...sizeReport(changeDir).problems, ...whyReport(root, changeDir).problems].filter((p) => p.severity === 'error');
  if (pbad.length) { printJson({ result: 'plan', problems: pbad, fix: 'Re-plan with /spec-fix (merge tasks, or change Size: in proposal.md and write the full artifacts for that size; Why problems: fix the Why lines of the delta specs and the Owner approval line), then rerun.' }); process.exit(EXIT.USAGE); }
  if (o.newRun) { const old = currentRun(root, o.change, false); if (old) closeRun(root, o.change, old, 'superseded'); }
  const run = currentRun(root, o.change, false);
  let state = run && fs.existsSync(path.join(run, 'state.json')) ? readState(run) : null;
  if (state && state.exhausted) { printJson({ result: 'exhausted', task: state.task, run }); process.exit(EXIT.EXHAUSTED); }
  if (state && state.review) { printJson({ result: 'review-pending', task: state.task.label, review_prompt: state.review.prompt, fix: `dispatch spec-visual-reviewer with ${state.review.prompt}, then run \`review ${o.change} --reply <file>\`` }); process.exit(EXIT.USAGE); }
  // A ticked task that no check passed (re-ticked after a failed check, or ticked without one) is never skipped.
  const ledger = readLedger(root, o.change, j.tasks);
  const foreign = foreignRecords(j.tasks, ledger, files);
  const unverified = j.tasks.filter((t) => t.done && (!isVerified(ledger, t.description) || foreign.has(t.description)));
  if (unverified.length) {
    const cur = state && state.task ? unverified.find((t) => t.description === state.task.description) : null;
    const others = unverified.filter((t) => t !== cur).map((t) => t.description);
    const fix = cur
      ? `task ${state.task.label} is ticked in tasks.md but has no passing check: run \`check ${o.change} --reported done\` now (it verifies the tick; after a failed check it opens the next attempt itself, no \`next\` needed)${others.length ? `; also untick ${others.join('; ')}` : ''}`
      : `tasks.md has ticked tasks that no check passed: ${others.join('; ')}. Untick them (\`- [ ]\`) and rerun \`next ${o.change}\`: it hands out the first unticked task and \`check\` verifies it. Never tick a task without \`check\``;
    printJson({ result: 'unverified-ticks', tasks: unverified.map((t) => t.description), ...(foreign.size ? { foreign: Object.fromEntries(foreign) } : {}), fix });
    process.stderr.write(`verify-task: REFUSED: ${fix}\n`); process.exit(EXIT.USAGE);
  }
  const pending = j.tasks.find((t) => !t.done);
  if (!pending) {
    if (run) closeRun(root, o.change, run, 'complete');
    printJson({ result: 'complete', progress: j.progress, status: RS.summary(readLedger(root, o.change, []), RS.readJson(path.join(runsDir(root, o.change), 'finished.json')), RS.fingerprint(CODE_ROOT), j.tasks.length) }); process.exit(EXIT.DONE);
  }
  const r = run || currentRun(root, o.change, true);
  let fresh = false;
  if (!state || !state.task || state.task.description !== pending.description) {
    fresh = true;
    // New dispatch: snapshot every task file before the subagent touches it.
    const snaps = files.map((f, i) => { const snap = path.join(r, 'pre', `${Date.now()}-${i}.md`); fs.copyFileSync(f, snap); return { file: f, snap }; });
    const locs = taskLocations(j.tasks, files);
    const members = batchTasks(j, files, pending, changeDir, o).map((t) => {
      const where = locs[j.tasks.indexOf(t)]; const det = details(fs.readFileSync(where.file, 'utf8'), where.line);
      const m = t.description.match(/^(\S+)\s+(.*)$/);
      return { id: t.id, description: t.description, line: where.line, file: where.file, label: m ? m[1] : t.id, title: m ? m[2] : t.description, details: det, done_when: doneWhenCmd(det) };
    });
    state = {
      change: o.change, started: new Date().toISOString(), attempts: 0, last_failure: null,
      task: { ...members[0], label: members.length > 1 ? `${members[0].label}-${members[members.length - 1].label}` : members[0].label, details: members.flatMap((m) => m.details), members },
      pre_tasks: j.tasks.map((t) => ({ description: t.description, done: t.done })), snapshots: snaps,
    };
    logMetric(r, { event: 'dispatch', task: state.task.label, remaining: j.progress && j.progress.remaining });
    recordBase(root, o.change);
  }
  state.attempt_open = true;
  writeState(r, state);
  const warnings = [];
  if (tinfo.state === 'none') warnings.push('the project test command is disabled (Test command: none); only Done when and validate are checked');
  const vt = resolveRefs(visualRefs(state.task.details), vl.scenarios).found;
  const vcfg = visualConfig(root);
  if (vt.length) {
    const vp = VC.configProblem(vcfg);
    if (vp) { state.attempt_open = false; writeState(r, state); printJson({ result: 'config', problem: vp }); process.stderr.write(`verify-task: REFUSED: task ${state.task.label} names visual scenarios but ${vp}\n`); process.exit(EXIT.USAGE); }
    if (vcfg.off) warnings.push('task names visual scenarios but `visual: off` in openspec/config.yaml: nothing visual will be checked');
  }
  if (fresh) {
    // The task's "before": the declared scenarios as they are now, before the implementer edits anything.
    const vb = await captureBefore(r, root, changeDir, state, files);
    if (vb) {
      state.visual_before = vb; writeState(r, state);
      logMetric(r, { event: 'visual-before', task: state.task.label, ok: vb.ok, seconds: vb.seconds, source: vb.source });
      if (!vb.ok) warnings.push(`could not capture the pre-task state of the visual scenarios (${vb.skipped || vb.server.join(', ') || 'unknown'}); check will try a git worktree of HEAD`);
    }
  }
  const self = `node ${path.relative(CODE_ROOT, __filename) || __filename} visual ${o.change}`;
  const tr = specRefsOf(state, Q.specScenarios(path.join(changeDir, 'specs')));
  const tagIds = (xs) => xs.filter((x) => !x.visual || vcfg.off).map((x) => x.id);
  const packet = {
    result: 'task', change: o.change, openspec_root: root, code_root: CODE_ROOT, change_dir: changeDir, run: r,
    task: { label: state.task.label, title: state.task.title, details: state.task.details },
    batch: membersOf(state).map((m) => ({ label: m.label, title: m.title, details: m.details })),
    done_when: state.task.done_when.cmd, test_cmd: tinfo.cmd,
    read: ['proposal.md', 'specs', 'design.md', 'design-map.md', 'adrs', 'tasks.md', 'progress.md'].map((f) => path.join(changeDir, f)).filter((f) => fs.existsSync(f)),
    earlier: files.flatMap((f) => Q.parsePlan(fs.readFileSync(f, 'utf8')).groups.flatMap((g) => g.tasks.filter((t) => t.done && !t.review).map((t) => `${t.label} ${t.title}${t.files.length ? ` (${t.files.join(', ')})` : ''}`))),
    attempt: state.attempts + 1, max_attempts: o.maxAttempts, last_failure: state.last_failure, progress: j.progress,
    visual: { scenarios: vt.map((s) => s.id), viewports: [...new Set(vt.flatMap((s) => s.viewports))].sort((a, b) => a - b), references: vt.map((s) => VC.resolveReference(s, changeDir, root)).filter(Boolean), self_check: self, guards: vcfg.scope === 'all' },
    trace: { scenarios: tagIds(tr.explicit), requirement_level: tagIds(tr.implicit) },
    anchors: traceMode(root) === 'off' ? [] : [...new Set([...tr.explicit, ...tr.implicit].map((x) => x.requirement && `${x.capability}/${Q.slug(x.requirement)}`).filter(Boolean))],
    warnings,
    review_range: Q.isReviewTask(state.task.label, state.task.title) ? RS.reviewRange(CODE_ROOT, changeBase(root, o.change)) || undefined : undefined,
  };
  for (const w of warnings) process.stderr.write(`verify-task: WARNING: ${w}\n`);
  if (o.format === 'prompt') { timelineOf('next', packet); process.stdout.write(packetPrompt(packet) + '\n'); } else printJson(packet);
  process.exit(EXIT.OK);
}

function restore(state) { for (const s of state.snapshots) fs.copyFileSync(s.snap, s.file); }
/** The tasks one dispatch covers (state files of a single task have no `members`). */
const membersOf = (state) => state.task.members || [state.task];
const isTarget = (state, file, line) => membersOf(state).some((m) => m.file === file && m.line === line);
const specLineOf = (m) => (m.details.find((l) => /^Spec:/i.test(l)) || '').replace(/^Spec:\s*/i, '');
/** Scenario references of every Spec: line of the dispatch. */
function specRefsOf(state, scens) {
  const r = { explicit: [], implicit: [] };
  for (const m of membersOf(state)) { const l = specLineOf(m); if (l) { const x = Q.specRefs(l, scens); r.explicit.push(...x.explicit); r.implicit.push(...x.implicit); } }
  return r;
}
/** What one `next` hands out: Size S the whole change, Size M/L one task group, no Size line one task; a review task is alone. */
function batchTasks(j, files, pending, changeDir, o) {
  const split = (t) => { const m = t.description.match(/^(\S+)\s+(.*)$/); return m ? [m[1], m[2]] : ['', t.description]; };
  const isReview = (t) => Q.isReviewTask(...split(t));
  const size = Q.proposalSize(proposalText(changeDir)).size;
  const scope = o.perTask || !size || isReview(pending) ? 'task' : size === 'S' ? 'change' : 'group';
  const at = taskLocations(j.tasks, files); const i0 = j.tasks.indexOf(pending);
  const groupOf = (k) => { const g = Q.parsePlan(fs.readFileSync(at[k].file, 'utf8')).groups.find((x) => x.tasks.some((t) => t.line === at[k].line)); return `${at[k].file}:${g ? g.line : 0}`; };
  const out = [pending];
  if (scope === 'task') return out;
  const g0 = groupOf(i0);
  for (let k = i0 + 1; k < j.tasks.length; k++) { const t = j.tasks[k]; if (t.done || isReview(t) || (scope === 'group' && groupOf(k) !== g0)) break; out.push(t); }
  return out;
}
/** The verifier ticks the dispatch's boxes itself once every check passed (an agent that ticked them already changes nothing). */
function tickTask(state) {
  for (const m of membersOf(state)) {
    const lines = fs.readFileSync(m.file, 'utf8').split('\n'); const i = m.line - 1;
    if (/^\s*[-*+]\s+\[ \]/.test(lines[i] || '')) { lines[i] = lines[i].replace('[ ]', '[x]'); fs.writeFileSync(m.file, lines.join('\n')); }
  }
}
function recordPasses(root, change, run, state) { for (const m of membersOf(state)) recordPass(root, change, run, m); }

function diffTasks(state, files) {
  const problems = [];
  for (const s of state.snapshots) {
    if (!fs.existsSync(s.file)) { problems.push(`${s.file} was deleted`); continue; }
    const pre = fs.readFileSync(s.snap, 'utf8').split('\n'); const post = fs.readFileSync(s.file, 'utf8').split('\n');
    if (pre.length !== post.length) problems.push(`${path.basename(s.file)}: line count changed ${pre.length} -> ${post.length} (tasks or details added or deleted)`);
    const n = Math.min(pre.length, post.length);
    for (let i = 0; i < n; i++) {
      if (pre[i] === post[i]) continue;
      const target = isTarget(state, s.file, i + 1) && post[i] === pre[i].replace(/\[ \]/, '[x]');
      if (!target) problems.push(`${path.basename(s.file)}:${i + 1} changed: "${pre[i].trim()}" -> "${post[i].trim()}"`);
    }
  }
  for (const f of files) if (!state.snapshots.some((s) => s.file === f)) problems.push(`new task file ${f}`);
  return problems;
}

/**
 * Visual items for a task. role task: the scenarios its `Visual:` line names (all defects count; area images and
 * ARIA diff go to the reviewer). role change: scenarios named by earlier ticked tasks of this change. role guard:
 * every scenario in the main specs (openspec/specs) that this change does not redefine. change and guard scenarios
 * are compared with the capture taken before the task: new defects fail, and so does an ARIA change unless the
 * scenario's `component:` is in the task's Files: (inScope). Scenarios of later tasks are not opened yet.
 */
function visualPlan(root, changeDir, state, files) {
  const cfg = visualConfig(root);
  const scens = changeScenarios(changeDir);
  const mine = resolveRefs(visualRefs(state.task.details), scens).found;
  const earlier = new Set();
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8'); const lines = text.split('\n');
    lines.forEach((l, i) => { if (/^\s*[-*+]\s+\[[xX]\]\s/.test(l) && !isTarget(state, f, i + 1)) resolveRefs(visualRefs(details(text, i + 1)), scens).found.forEach((x) => earlier.add(x)); });
  }
  const changeIds = new Set(scens.map((x) => x.id));
  // A review task may fix what it finds anywhere the change already works: its scope is every file named in the
  // Files: lines of the change's tasks (plus its own). Every other task keeps its own Files: as its scope.
  const review = Q.isReviewTask(state.task.label, state.task.title);
  const scopeFiles = [...filesOf(state.task.details), ...(review ? changeTaskFiles(files) : [])];
  const declared = scopeFiles.map((f) => path.basename(f).replace(/\.[^.]+$/, '').toLowerCase());
  const inScope = (x) => !!(x.component && declared.includes(x.component.toLowerCase()));
  const own = cfg.scope === 'task'; // visual.scope: task -- this task's own scenarios only; the others wait for `finish`
  const guard = own ? [] : VC.scenariosIn(path.join(root, 'openspec/specs')).filter((x) => !changeIds.has(x.id));
  const shots = cfg.screenshots !== 'off' && cfg.review !== 'off';
  const items = [
    ...mine.map((x) => ({ scenario: x, role: 'task', inScope: true, shots })),
    ...(own ? [] : [...earlier]).filter((x) => !mine.includes(x)).map((x) => ({ scenario: x, role: 'change', inScope: inScope(x), shots: false })),
    ...guard.map((x) => ({ scenario: x, role: 'guard', inScope: inScope(x), shots: false })),
  ];
  const changed = changedFiles();
  const declaredUi = filesOf(state.task.details).filter((f) => VC.isUiFile(f, cfg));
  const touched = (changed || filesOf(state.task.details)).filter((f) => VC.isUiFile(f, cfg));
  return { cfg, items, mine, touched, declaredUi, triggered: mine.length > 0 || touched.length > 0 };
}

/** Every file named in a `Files:` line of the change's tasks. */
function changeTaskFiles(files) {
  const out = new Set();
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    text.split('\n').forEach((l, i) => { if (/^\s*[-*+]\s+\[[ xX]\]\s/.test(l)) filesOf(details(text, i + 1)).forEach((x) => out.add(x)); });
  }
  return [...out];
}

/** "Before" capture from a temporary git worktree of HEAD (node_modules linked in), when `next` did not take one. */
async function captureAtHead(items, cfg, outDir) {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'spec-visual-before-'));
  const wt = path.join(tmp, 'tree');
  const add = spawnSync('git', ['worktree', 'add', '--detach', '--quiet', wt, 'HEAD'], { cwd: CODE_ROOT, encoding: 'utf8' });
  if (add.status !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); return { rep: null, note: `no git worktree of HEAD (${(add.stderr || '').trim().split('\n')[0] || 'not a git repository'})` }; }
  try {
    for (const d of ['node_modules']) if (fs.existsSync(path.join(CODE_ROOT, d)) && !fs.existsSync(path.join(wt, d))) fs.symlinkSync(fs.realpathSync(path.join(CODE_ROOT, d)), path.join(wt, d));
    const rep = await VC.run({ codeRoot: wt, outDir, config: cfg, items, before: true });
    return { rep, note: 'temporary git worktree of HEAD (uncommitted work of earlier tasks counts as changed)' };
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: CODE_ROOT });
    spawnSync('git', ['worktree', 'prune'], { cwd: CODE_ROOT });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
function loadReport(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }

/** Take the task's "before" capture now (called by `next` on a new dispatch, while the tree is still pre-task). */
async function captureBefore(run, root, changeDir, state, files) {
  const plan = visualPlan(root, changeDir, state, files);
  if (plan.cfg.off || VC.configProblem(plan.cfg) || !plan.items.length || !(plan.mine.length || plan.declaredUi.length)) return null;
  const dir = path.join(run, 'visual', state.task.label, 'before');
  const rep = await VC.run({ codeRoot: CODE_ROOT, outDir: dir, config: plan.cfg, items: plan.items, before: true });
  return { dir, report: path.join(dir, 'report.json'), source: 'pre-task tree (next)', seconds: rep.seconds, ok: rep.ran, skipped: rep.skipped, server: rep.defects.filter((d) => d.code.startsWith('server:')).map((d) => d.code) };
}

/** After capture + comparison with the before capture (taking one from HEAD if `next` did not). */
/**
 * visual.changed_only: on (or `visual --changed-only`) -- the cache file of this exact visual run: the same pages, scenarios, limits,
 * pre-task capture and the same app files (the working tree without tests, Markdown and run state). null when it is off, when an item
 * needs its images for the visual review, when a scenario logs in as a role (its result depends on credentials, env vars and the login),
 * or outside git. Only a run with no defects is stored, so a hit can only repeat a pass.
 */
function visualCacheFile(o, root, plan, state, run) {
  if (!(plan.cfg.changed_only || o.changedOnly) || o.noCache || process.env.SPEC_NO_CACHE || plan.items.some((x) => x.shots || (x.scenario.role && x.scenario.role !== 'anonymous'))) return null;
  const tree = RS.appTree(CODE_ROOT); if (!tree) return null;
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: CODE_ROOT, encoding: 'utf8' }).stdout.trim();
  const before = state && state.visual_before ? [state.visual_before.source, state.visual_before.report] : null;
  const key = crypto.createHash('sha1').update(JSON.stringify([tree, head, before, plan.items.map((x) => [x.role, x.inScope, x.scenario]), { ...plan.cfg, sources: null }])).digest('hex');
  return path.join(runsDir(root, o.change), 'cache', `visual-${key}.json`);
}
async function runVisual(o, root, changeDir, plan, state, run, outDir) {
  const vcache = visualCacheFile(o, root, plan, state, run);
  const hit = vcache && RS.readJson(vcache);
  if (hit) return { ran: true, defects: [], all_defects: 0, preexisting: 0, baseline_defects: 0, aria_changes: [], pairs: [], shots: [], ignored: [], notes: [], warnings: [`visual: nothing the pages are built from changed since the identical run that passed ${hit.at} (${hit.seconds}s): not run again (visual.changed_only)`], seconds: 0, before: 'unchanged', before_seconds: 0, cached: true };
  const out = await runVisualNow(o, root, changeDir, plan, state, run, outDir);
  if (vcache && out.ran && !out.skipped && !out.defects.length) RS.cachePut(vcache, { at: new Date().toISOString(), seconds: out.seconds });
  return out;
}
async function runVisualNow(o, root, changeDir, plan, state, run, outDir) {
  let before = state && state.visual_before && state.visual_before.ok ? loadReport(state.visual_before.report) : null;
  let beforeNote = before ? state.visual_before.source : null; let beforeSeconds = 0;
  if (!before && (plan.cfg.baseline || plan.items.some((x) => x.role !== 'task' || x.shots))) {
    const t = Date.now(); const r = await captureAtHead(plan.items, plan.cfg, path.join(run, 'visual', state ? state.task.label : 'self', 'before-head'));
    beforeSeconds = (Date.now() - t) / 1000;
    if (r.rep && r.rep.ran) { before = r.rep; beforeNote = r.note; if (state) { state.visual_before = { dir: r.rep.out_dir, report: path.join(r.rep.out_dir, 'report.json'), source: r.note, seconds: r.rep.seconds, ok: true }; } } else beforeNote = `none: ${r.note || (r.rep && (r.rep.skipped || 'the app did not start at HEAD'))}`;
  }
  for (const it of plan.items) it.refs = VC.resolveReferences(it.scenario, changeDir, root); // side-by-side with the design
  const after = await VC.run({ codeRoot: CODE_ROOT, outDir, config: plan.cfg, items: plan.items });
  const cmp = after.ran ? VC.compare(after, before, { baseline: !!plan.cfg.baseline }) : { defects: after.defects, preexisting: 0, aria_changes: [], pairs: [], baseline: [] };
  if (cmp.baseline && cmp.baseline.length) after.warnings.push(VC.baselineReport(cmp.baseline));
  else if (plan.cfg.baseline && after.ran && !before) after.warnings.push('visual.baseline is on, but there is no capture from before the task: every defect counts');
  if (after.ran && !before) {
    // Without a before capture a defect in another scenario may be old: report it, but do not fail the task on it.
    const keep = []; for (const d of cmp.defects) { if (d.role && d.role !== 'task') after.warnings.push(`no before capture, so this may predate the task: ${d.message}`); else keep.push(d); }
    cmp.defects = keep;
    if (plan.items.some((x) => x.role !== 'task')) after.warnings.push(`no before capture (${beforeNote || 'none'}): other declared scenarios were checked for defects only, not for ARIA changes`);
  }
  if (after.ignored && after.ignored.length) after.warnings.push(VC.ignoredReport(after.ignored));
  if (after.notes && after.notes.length) after.warnings.push(VC.skippedStepsReport(after.notes));
  const out = { ...after, defects: cmp.defects, all_defects: after.defects.length, preexisting: cmp.preexisting, baseline_defects: (cmp.baseline || []).length, aria_changes: cmp.aria_changes, pairs: cmp.pairs, before: beforeNote, before_seconds: beforeSeconds };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(out, null, 2) + '\n');
  return out;
}

/**
 * The anchor guard over the diff against `base`. Returns null when it is off (anchor_guard: off or traceability: off).
 * { level, findings, touched, events }. `scope`: 'task' (no sprawl, no reverse check) | 'change'.
 */
function anchorGuardReport(root, changeDir, base, scope, taskFiles) {
  if (T.mode(configFiles(root)) === 'off') return null;
  const level = T.guardLevel(configFiles(root)); if (level === 'off' || !base) return null;
  const m = T.changeMentions(root, changeDir);
  const mine = new Set(); for (const d of T.changeDeltas(changeDir)) for (const r of d.reqs) if (r.op === 'ADDED' || r.op === 'MODIFIED') mine.add(`${d.cap}/${r.slug}`);
  // a requirement that is truly spread over many files says so (`Anchors: many` in it, or `anchor_many:` in the config): no sprawl finding for it
  const manyKeys = new Set(FIT.fitConfig(configFiles(root), (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } }).many);
  for (const d of T.changeDeltas(changeDir)) for (const q of d.reqs) if (/^\s*Anchors:\s*many\b/mi.test(q.block || '')) manyKeys.add(`${d.cap}/${q.slug}`);
  const r = AG.guard({ codeRoot: CODE_ROOT, base, manyKeys, listed: m.listed, reviewed: m.reviewed, modifiedKeys: scope === 'change' ? m.modified : null, removedKeys: m.removed, mineKeys: scope === 'change' ? mine : new Set(), markers: T.scanAnchors(CODE_ROOT), isTest: Q.isTestPath, taskFiles: scope === 'task' ? taskFiles : null });
  return { level, ...r };
}
/** Put guard findings into warnings, or failures with anchor_guard: error and traceability on. */
function addGuard(rep, md, checks, failures, warnings) {
  if (!rep) return;
  const hard = rep.level === 'error' && md === 'on';
  checks.push({ check: 'anchor_guard', ok: !(hard && rep.findings.length), findings: rep.findings.length, kinds: [...new Set(rep.findings.map((f) => f.kind))] });
  if (hard && rep.findings.length) failures.push(`anchor guard (anchor_guard: error):\n${rep.findings.map((f) => `- ${f.kind}: ${f.text}`).join('\n')}`);
  else for (const f of rep.findings) warnings.push(`anchor guard: ${f.kind}: ${f.text}`);
}

/** Per-task quality rules: source-text tests among the files this task changed, and trace tags for the scenarios its
 *  `Spec:` line names one by one (requirement-level references only warn: a later task may cover the rest). */
function qualityChecks(root, changeDir, state) {
  const out = { checks: [], failures: [], warnings: [] };
  const tests = (changedFiles() || []).filter((f) => Q.isTestFile(f) && fs.existsSync(path.join(CODE_ROOT, f)));
  const st = sourceTextCheck(tests);
  out.checks.push({ check: 'source_text', ok: !st.bad.length, files: tests.length, findings: st.bad.length, allowed: st.allowed.length });
  if (st.bad.length) out.failures.push(`tests read source files as text:\n${st.bad.map((x) => '- ' + x).join('\n')}\n${Q.SOURCE_TEXT_FIX}`);
  for (const a of st.allowed) out.warnings.push(`allowed source-text test: ${a}`);
  addTokenLint(designTokenLint(changeDir, changedFiles()), out.checks, out.failures, out.warnings);
  for (const f of (changedFiles() || []).filter((x) => /\.(vue|jsx|tsx|svelte|astro|html?)$/.test(x) && !Q.isTestPath(x))) for (const a of Q.ariaLabelFindings(path.join(CODE_ROOT, f), f)) out.warnings.push(`accessible name: ${a.text}`);
  if (traceMode(root) !== 'off') {
    const changed = (changedFiles() || []).filter((f) => fs.existsSync(path.join(CODE_ROOT, f)));
    const bad = RS.timed('scan: @spec markers in changed files', () => T.markerProblems(root, changeDir, CODE_ROOT, changed));
    out.checks.push({ check: 'anchors', ok: !bad.length || traceMode(root) === 'warn', unresolved: bad.length });
    const msg = bad.map((m) => `${m.file}:${m.line}: \`@spec ${m.key}\` does not resolve to a requirement${m.hint ? ` (did you mean ${m.hint}?)` : ''}`);
    if (bad.length && traceMode(root) === 'on') out.failures.push(`code anchors that do not resolve (the slug is the requirement name lower-cased with dashes; \`verify-task.cjs anchors ${path.basename(changeDir)}\` lists the valid ones):\n${msg.map((x) => '- ' + x).join('\n')}`);
    else out.warnings.push(...msg);
    const lvl = T.placementLevel(configFiles(root));
    if (lvl !== 'off') {
      const pl = T.placementProblems(CODE_ROOT, null, changed).map((x) => `${x.file}:${x.line}: ${x.kind}: ${x.text}`);
      if (pl.length && lvl === 'error' && traceMode(root) === 'on') { out.checks.push({ check: 'marker_placement', ok: false, findings: pl.length }); out.failures.push(`marker placement (anchor_placement: error; verify-task.cjs help lists the rules):\n${pl.map((x) => '- ' + x).join('\n')}`); }
      else out.warnings.push(...pl.map((x) => `marker placement: ${x}`));
    }
    addGuard(anchorGuardReport(root, changeDir, 'HEAD', 'task', filesOf(state.task.details)), traceMode(root), out.checks, out.failures, out.warnings);
  }
  if (membersOf(state).some(specLineOf)) {
    const t = traceFor(root, changeDir, visualConfig(root));
    const refs = specRefsOf(state, t.scens);
    const miss = refs.explicit.filter((x) => t.res.missing.includes(x));
    const soft = refs.implicit.filter((x) => t.res.missing.includes(x));
    out.checks.push({ check: 'trace', ok: !miss.length, named: refs.explicit.length, untested: miss.map((x) => x.id), requirement_level_untested: soft.length });
    if (miss.length) out.failures.push(`no test is tagged for ${miss.length} scenario(s) this task's Spec: line names: ${miss.map((x) => `[${x.id}]`).join(', ')}. ${TAG_HELP}`);
    if (soft.length) out.warnings.push(`Spec: names requirement(s) without picking scenarios; untested so far: ${soft.map((x) => `[${x.id}]`).join(', ')} (finish fails if they stay untested)`);
  }
  return out;
}

async function cmdCheck(o) {
  const { root, changeDir } = context(o);
  const run = currentRun(root, o.change, false);
  if (!run || !fs.existsSync(path.join(run, 'state.json'))) die('no task in progress: run `next` first');
  PROFILE_RUN = run;
  const state = readState(run);
  if (!state.task) die(`no task in progress: the last task was already checked and passed; run \`next ${o.change}\` to start the next task before \`check\` (if you already ticked its box in tasks.md, untick it first: \`next\` picks the first unticked task)`);
  if (state.exhausted) { printJson({ result: 'exhausted', task: state.task.label }); process.exit(EXIT.EXHAUSTED); }
  if (state.review) die(`task ${state.task.label} is waiting for its visual review: dispatch spec-visual-reviewer with ${state.review.prompt}, then run \`review ${o.change} --reply <file>\``);
  const warnings = [];
  if (!state.attempt_open) {
    if (!state.attempts) die(`task ${state.task.label} was not handed out: run \`next ${o.change}\` first`);
    // After a failed check: the fix is checked again directly (same snapshot and pre-task capture as \`next\` would use).
    state.attempt_open = true; writeState(run, state);
    warnings.push(`attempt ${state.attempts + 1} of ${o.maxAttempts} of task ${state.task.label} opened by this check (the previous check failed; no \`next\` needed)`);
    logMetric(run, { event: 'reopen', task: state.task.label, attempt: state.attempts + 1 });
  }
  const t0 = Date.now(); const failures = []; const checks = [];
  const blocked = fs.existsSync(path.join(changeDir, 'BLOCKED.md'));
  const tinfo = testCmdInfo(o, root); const tprob = testCmdProblem(tinfo);
  if (tprob) die(`REFUSED: ${tprob}`);

  // 1. tasks.md: exactly the target tick, nothing else.
  const j = applyInstructions(root, o.change);
  const files = taskFiles(j);
  // A run opened by a version that kept no line for the task (OpenSpec 1.7.x gives none): find the checkbox again.
  if (!state.task.line || !state.task.file) { const w = taskLocations([{ description: state.task.description, done: false }], files)[0]; state.task.line = w.line; state.task.file = w.file; }
  const diff = diffTasks(state, files);
  const newly = j.tasks.filter((t) => t.done && !(state.pre_tasks.find((p) => p.description === t.description) || {}).done).map((t) => t.description);
  const deleted = state.pre_tasks.filter((p) => !j.tasks.some((t) => t.description === p.description)).map((p) => p.description);
  if (deleted.length) failures.push(`tasks deleted or reworded: ${deleted.join('; ')}`);
  if (newly.length > membersOf(state).length) failures.push(`more than ${membersOf(state).length === 1 ? 'one task' : `${membersOf(state).length} tasks`} ticked: ${newly.join('; ')}`);
  if (diff.length) failures.push(...diff.map((d) => `tasks.md edited outside the target checkbox: ${d}`));
  checks.push({ check: 'tasks', ok: !failures.length, newly_ticked: newly.length, deleted: deleted.length });

  // 2. subagent's own report and BLOCKED.md
  if (blocked) failures.push('BLOCKED.md exists');
  if (o.reported !== 'done') failures.push(`subagent reported STATUS: ${o.reported}`);

  // 3-6. commands and the visual check, only when the bookkeeping is right (saves minutes on an obvious failure)
  let visual = null; let review = null; let rubric = [];
  if (!failures.length) {
    const cmds = [];
    // A Done when command that is the project's tests, typecheck or lint runs as that command: same cache, same time limit.
    const proj = new Map();
    if (tinfo.cmd) proj.set(norm(tinfo.cmd), 'tests');
    for (const x of EXTRA_CMDS) { const e = extraCmdInfo(root, x); if (e.cmd && !proj.has(norm(e.cmd))) proj.set(norm(e.cmd), x.name); }
    for (const m of membersOf(state)) {
      if (m.done_when.cmd) cmds.push(['done_when', m.done_when.cmd, CODE_ROOT, proj.get(norm(m.done_when.cmd))]);
      else checks.push({ check: 'done_when', ok: true, skipped: m.done_when.line ? 'no `command` in Done when line' : 'no Done when line' });
    }
    const deferWhy = deferReason(root, state);
    const ran = new Set(membersOf(state).flatMap((m) => doneWhenParts(m.done_when.cmd)).map(norm));
    if (tinfo.cmd && ran.has(norm(tinfo.cmd))) checks.push({ check: 'tests', ok: true, skipped: 'already run by Done when' });
    else if (tinfo.cmd && testRunMode(root) === 'finish') checks.push({ check: 'tests', ok: true, skipped: 'Test run: finish (the project tests run once at finish)' });
    else if (tinfo.cmd && checkLevel(root) === 'targeted' && !Q.isReviewTask(state.task.label, state.task.title)) {
      const tg = targetedTests(root, changeDir, state, tinfo.cmd);
      checks.push({ check: 'targeted_tests', ok: true, files: tg.files.length, ...(tg.counts ? { from: tg.counts } : {}), ...(tg.tpl ? { template: tg.tpl } : {}), ...(tg.cmd ? {} : { skipped: tg.why }) });
      if (tg.cmd) cmds.push(['tests', tg.cmd, CODE_ROOT]); else process.stderr.write(`verify-task: note: tests not run at this check: ${tg.why}\n`);
    } else if (tinfo.cmd && deferWhy) checks.push({ check: 'tests', ok: true, skipped: deferWhy });
    else if (tinfo.cmd) cmds.push(['tests', tinfo.cmd, CODE_ROOT]);
    else { checks.push({ check: 'tests', ok: true, skipped: 'Test command: none' }); warnings.push('project tests were not run (Test command: none)'); }
    for (const x of EXTRA_CMDS) {
      const e = extraCmdInfo(root, x);
      if (!e.cmd) { if (e.state === 'placeholder') warnings.push(`${x.label} is still <fill in> in openspec/config.yaml: ${x.name} was not run (set it, or write none)`); continue; }
      if (ran.has(norm(e.cmd))) { checks.push({ check: x.name, ok: true, skipped: 'already run by Done when' }); continue; }
      if (deferWhy) { checks.push({ check: x.name, ok: true, skipped: deferWhy }); continue; }
      cmds.push([x.name, e.cmd, CODE_ROOT]);
    }
    cmds.push(['visual'], ['validate', `openspec validate '${o.change}' --strict`, root]);
    // Tests must not read source files as text (quality.cjs); scenarios this task names must have a tagged test.
    const tq = qualityChecks(root, changeDir, state);
    checks.push(...tq.checks); failures.push(...tq.failures); warnings.push(...tq.warnings);
    if (tq.failures.length) cmds.length = 0;
    const treeKey = cmds.some(([n, , , via]) => PROJECT_CMDS.has(via || n)) ? phaseTree(o) : null;
    const ranCmds = new Map(); // normalised command -> check name: two tasks of a batch naming the same command run it once
    for (const [name, cmd, cwd, via] of cmds) {
      if (name === 'visual') {
        const plan = visualPlan(root, changeDir, state, files);
        if (!plan.triggered) continue;
        const vprob = VC.configProblem(plan.cfg);
        if (vprob) { checks.push({ check: 'visual', ok: false, reason: 'config' }); failures.push(`visual check needed (${plan.mine.length ? `task names ${plan.mine.map((x) => x.id).join(', ')}` : `UI files changed: ${plan.touched.slice(0, 5).join(', ')}`}) but ${vprob}`); break; }
        if (plan.cfg.off) { checks.push({ check: 'visual', ok: true, skipped: 'visual: off' }); warnings.push('UI work but `visual: off` in openspec/config.yaml: nothing visual was checked'); continue; }
        if (!plan.items.length) { checks.push({ check: 'visual', ok: true, skipped: 'no visual scenario covers the changed UI files' }); warnings.push(`UI files changed (${plan.touched.slice(0, 5).join(', ')}) but no visual scenario covers them: add one to the specs with /spec-fix so the next change is checked`); continue; }
        const outDir = path.join(run, 'visual', `${state.task.label}-a${state.attempts + 1}`);
        const rep = await runVisual(o, root, changeDir, plan, state, run, outDir);
        visual = { dir: outDir, report: path.join(outDir, 'report.json'), scenarios: plan.items.map((x) => `${x.scenario.id} (${x.role})`), before: rep.before, area_images: rep.shots.length, aria_changes: rep.aria_changes.length, defects: rep.defects.length, preexisting_elsewhere: rep.preexisting, seconds: rep.seconds, before_seconds: rep.before_seconds, skipped: rep.skipped, warnings: rep.warnings };
        for (const w of rep.warnings) warnings.push(w);
        if (rep.skipped) {
          checks.push({ check: 'visual', ok: !plan.cfg.require_playwright, skipped: rep.skipped, seconds: rep.seconds });
          if (plan.cfg.require_playwright) { failures.push(`visual check could not run (${rep.skipped}) and visual.require_playwright is true: ${rep.warnings[0]}`); break; }
          continue;
        }
        checks.push({ check: 'visual', ok: rep.defects.length === 0, defects: rep.defects.length, area_images: rep.shots.length, seconds: rep.seconds, before_seconds: rep.before_seconds });
        if (rep.defects.length) { failures.push(`visual check failed: ${rep.defects.length} defect(s). Fix each one (report: ${path.join(outDir, 'report.json')}):\n${VC.summarize(rep.defects).join('\n')}`); break; }
        if (plan.mine.length && plan.cfg.review !== 'off' && plan.cfg.screenshots !== 'off' && rep.shots.length) {
          const prompt = VC.reviewPrompt({ change: o.change, task: state.task.label, attempt: state.attempts + 1, max_attempts: o.maxAttempts, root, pairs: rep.pairs, aria_changes: rep.aria_changes, scenarios: plan.mine.map((x) => ({ ...x, reference_path: VC.resolveReference(x, changeDir, root), reference_paths: VC.resolveReferences(x, changeDir, root), design_map: fs.existsSync(path.join(changeDir, 'design-map.md')) ? path.join(changeDir, 'design-map.md') : null })) });
          review = path.join(outDir, 'review-prompt.md'); fs.writeFileSync(review, prompt);
          rubric = plan.mine.filter((x) => x.references && x.references.length).map((x) => x.id);
        }
        continue;
      }
      if (ranCmds.has(norm(cmd))) { checks.push({ check: name, ok: true, skipped: `same command as ${ranCmds.get(norm(cmd))}` }); continue; }
      const r = await runNamed(o, root, via || name, cmd, cwd, treeKey);
      ranCmds.set(norm(cmd), name);
      checks.push({ check: name, ok: r.rc === 0, rc: r.rc, timed_out: r.timedOut, seconds: r.seconds, ...(r.cached ? { cached: true } : {}) });
      if (r.rc !== 0) { failures.push(`${name} failed${r.timedOut ? ` (timed out after ${r.limit}s)` : ` (exit ${r.rc})`}: ${cmd}\n${r.tail}`); break; }
    }
  }
  if (!failures.length) { const up = checkScope(root, o.change, changeDir); if (up.length) warnings.push(`left the fast path: ${up.join('; ')}. Write design.md, adrs/none.md (or ADRs) and app-map.md${Q.planPath(Q.sizeFacts(changeDir, { upgrade: readUpgrade(changeDir) })).review ? ', and add the final review task' : ''} before \`next\` continues`); }
  for (const w of warnings) process.stderr.write(`verify-task: WARNING: ${w}\n`);

  state.attempt_open = false;
  const seconds = (Date.now() - t0) / 1000;
  if (!failures.length && review) {
    state.review = { prompt: review, dir: visual.dir, checks, seconds, started: new Date().toISOString(), rubric };
    writeState(run, state);
    logMetric(run, { event: 'check', task: state.task.label, attempt: state.attempts + 1, ok: true, review_pending: true, seconds, checks });
    printJson({ result: 'review-pending', task: state.task.label, review_prompt: review, area_images: path.join(visual.dir, 'areas'), next: `dispatch an independent spec-visual-reviewer subagent with the review prompt, save its reply, then: review ${o.change} --reply <file>. Never review your own screenshots; if no subagent can run, record it as skipped: review ${o.change} --reviewer none`, checks, visual, warnings });
    process.exit(EXIT.REVIEW);
  }
  if (!failures.length) {
    logMetric(run, { event: 'check', task: state.task.label, attempt: state.attempts + 1, ok: true, seconds, checks });
    tickTask(state); recordPasses(root, o.change, run, state);
    const done = state.task.label; state.task = null; state.attempts = 0; state.last_failure = null; writeState(run, state);
    printJson({ result: 'passed', task: done, checks, visual, warnings, progress: applyInstructions(root, o.change).progress });
    process.exit(EXIT.OK);
  }
  reject(o, root, run, state, failures, { blocked, seconds, checks, visual, warnings });
}

/** Revert the tick, count the attempt, log, print and exit (shared by check and review). */
function reject(o, root, run, state, failures, x) {
  restore(state);
  state.review = null;
  state.attempts += 1;
  state.last_failure = failures.join('\n').slice(-TAIL);
  const exhausted = state.attempts >= o.maxAttempts;
  if (exhausted) state.exhausted = true;
  writeState(run, state);
  logMetric(run, { event: x.event || 'check', task: state.task.label, attempt: state.attempts, ok: false, blocked: x.blocked, exhausted, seconds: x.seconds, checks: x.checks, failures: failures.map((f) => f.split('\n')[0]), ...(x.metric || {}) });
  const out = { result: x.blocked ? 'blocked' : exhausted ? 'exhausted' : 'failed', task: state.task.label, attempt: state.attempts, max_attempts: o.maxAttempts, failures, reverted: true, checks: x.checks, visual: x.visual, warnings: x.warnings };
  if (x.blocked) closeRun(root, o.change, run, out.result); // exhausted keeps the run open so `next` keeps refusing until --new-run
  printJson(out);
  process.exit(x.blocked ? EXIT.BLOCKED : exhausted ? EXIT.EXHAUSTED : EXIT.FAIL);
}

function cmdReview(o) {
  const { root } = context(o);
  const run = currentRun(root, o.change, false);
  if (!run || !fs.existsSync(path.join(run, 'state.json'))) die('no task in progress: run `next` first');
  const state = readState(run);
  if (!state.review) die('no visual review is pending (only `check` exit 5 asks for one)');
  let text;
  if (o.reviewer === 'none') text = 'STATUS: pass\n';
  else try { text = o.reply === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(o.reply, 'utf8'); } catch (e) { die(`cannot read the reply ${o.reply}: ${e.message}`); }
  const r = VC.parseReview(text);
  if (!r.status) die('the reply has no `STATUS: pass` or `STATUS: fail` line; ask the reviewer again (nothing was recorded)');
  if (r.status === 'error') die('the reviewer could not review the screenshots (STATUS: error); dispatch it again, or, if no independent reviewer can run, record the review as skipped with `review <change> --reviewer none` (nothing was recorded)');
  if (r.status === 'fail' && !r.defects.length) die('the reply says STATUS: fail but lists no `DEFECT:` line, so the implementer would have nothing to fix; ask the reviewer again (nothing was recorded)');
  // Scenarios with a design reference need the cited design rubric (layout, hierarchy, spacing, colour, typography, components).
  const rprob = o.reviewer === 'none' ? [] : DC.rubricProblems(text, state.review.rubric || [], r.status, r.defects);
  if (rprob.length) die(`the reply's design rubric is incomplete (${rprob.slice(0, 4).join('; ')}${rprob.length > 4 ? `; +${rprob.length - 4} more` : ''}): every scenario with a design reference needs one \`RUBRIC: <scenario id> <item>: pass|fail - <what you compared>\` line per item (see the review prompt); ask the reviewer again (nothing was recorded)`);
  const rubricLog = (state.review.rubric || []).length ? DC.parseRubric(text).map((x) => `${x.scenario} ${x.item}:${x.verdict}`) : undefined;
  const seconds = (Date.now() - Date.parse(state.review.started)) / 1000;
  const checks = [...state.review.checks, { check: 'visual_review', ok: r.status === 'pass' && !r.defects.length, reviewer: o.reviewer, defects: r.defects.length, seconds, ...(rubricLog ? { rubric: rubricLog } : {}) }];
  if (r.status === 'pass' && !r.defects.length) {
    logMetric(run, { event: 'review', task: state.task.label, attempt: state.attempts + 1, ok: true, reviewer: o.reviewer, ...(o.reviewer === 'none' ? { skipped: true } : {}), seconds, ...(rubricLog ? { rubric: rubricLog } : {}) });
    tickTask(state); recordPasses(root, o.change, run, state);
    const done = state.task.label; state.task = null; state.attempts = 0; state.last_failure = null; state.review = null; writeState(run, state);
    printJson({ result: 'passed', task: done, checks });
    process.exit(EXIT.OK);
  }
  const failures = [`visual review failed (spec-visual-reviewer): ${r.defects.length} defect(s). Fix each one (area images: ${path.join(state.review.dir, 'areas')}):\n${r.defects.map((d) => `- ${d}`).join('\n')}`];
  reject(o, root, run, state, failures, { event: 'review', seconds, checks, metric: { reviewer: o.reviewer, ...(rubricLog ? { rubric: rubricLog } : {}) } });
}

async function cmdVisual(o) {
  const { root, changeDir } = context(o);
  const cfg = visualConfig(root); const vprob = VC.configProblem(cfg);
  if (vprob) die(`REFUSED: ${vprob}`);
  if (cfg.off) { printJson({ result: 'off', note: '`visual: off` in openspec/config.yaml' }); process.exit(EXIT.OK); }
  const scens = changeScenarios(changeDir);
  const lint = VC.lintScenarios(scens, changeDir, root, cfg);
  if (lint.length) { printJson({ result: 'visual-spec', problems: lint }); process.exit(EXIT.USAGE); }
  const run = currentRun(root, o.change, false);
  const state = run && fs.existsSync(path.join(run, 'state.json')) ? readState(run) : null;
  const files = taskFiles(applyInstructions(root, o.change));
  let plan;
  if (state && state.task && !o.scenarios.length) plan = visualPlan(root, changeDir, state, files);
  else {
    let pick = scens;
    if (o.scenarios.length) { const r = resolveRefs({ all: false, ids: o.scenarios }, scens); if (r.unknown.length) die(`unknown scenario(s): ${r.unknown.join(', ')} (known: ${scens.map((x) => x.id).join(', ') || 'none'})`); pick = r.found; }
    plan = { cfg, mine: pick, items: pick.map((x) => ({ scenario: x, role: 'task', inScope: true, shots: cfg.screenshots !== 'off' })) };
  }
  if (!plan.items.length) { printJson({ result: 'none', note: 'no visual scenario to check' }); process.exit(EXIT.OK); }
  const base = run || runsDir(root, o.change);
  const outDir = path.join(base, 'visual', `self-${stamp()}`);
  const rep = await runVisual(o, root, changeDir, plan, state && state.task && !o.scenarios.length ? state : null, base, outDir);
  if (state && state.task && state.visual_before && run) writeState(run, state);
  for (const w of rep.warnings) process.stderr.write(`verify-task: WARNING: ${w}\n`);
  const out = { result: rep.skipped ? 'skipped' : rep.defects.length ? 'defects' : 'clean', ignored: (rep.ignored || []).length, ...((rep.ignored || []).length ? { ignored_report: VC.ignoredReport(rep.ignored).split('\n').slice(1).map((x) => x.trim()) } : {}), ...((rep.notes || []).length ? { skipped_steps: VC.skippedStepsReport(rep.notes).split('\n').slice(1).map((x) => x.trim()) } : {}), scenarios: plan.items.map((x) => `${x.scenario.id} (${x.role})`), before: rep.before, report: path.join(outDir, 'report.json'), ...(rep.perf ? { perf: rep.perf } : {}), ...(rep.baseline_defects ? { baseline_defects: rep.baseline_defects } : {}), seconds: rep.seconds, defects: VC.summarize(rep.defects), aria_changes: rep.aria_changes.map((c) => ({ scenario: c.scenario, state: c.state, viewport: c.viewport, in_scope: c.role === 'task' || c.in_scope, diff: c.diff })), area_images: rep.pairs.length ? rep.pairs : rep.shots.map((x) => ({ scenario: x.scenario, state: x.state, viewport: x.viewport, after: x.file })), warnings: rep.warnings };
  printJson(out);
  process.exit(rep.skipped ? (cfg.require_playwright ? EXIT.FAIL : EXIT.USAGE) : rep.defects.length ? EXIT.FAIL : EXIT.OK);
}

/**
 * finish <change>: the deterministic close-out, run by the orchestrator once `next` reports complete (no agent):
 * full test command, typecheck and lint commands, `openspec validate --strict`, the visual check of every scenario of
 * the change (defects only), the trace check (every scenario has a `[capability/scenario-slug]` tagged test; visual
 * scenarios are covered by the visual check) and the source-text rule over the test files the change touched.
 * Exit 0 all passed · 1 failed: `fix_prompt` is a ready prompt for ONE spec-implementer subagent, then run finish again
 * · 4 attempts exhausted (--max-attempts) · 2 tasks still open or config error · 3 BLOCKED.md.
 */
async function cmdFinish(o) {
  const { root, changeDir } = context(o);
  if (fs.existsSync(path.join(changeDir, 'BLOCKED.md'))) { printJson({ result: 'blocked', blocked_file: path.join(changeDir, 'BLOCKED.md') }); process.exit(EXIT.BLOCKED); }
  const j = applyInstructions(root, o.change);
  const open = j.tasks.filter((t) => !t.done);
  if (open.length) { printJson({ result: 'tasks-open', remaining: open.map((t) => t.description), fix: 'finish runs after the last task: keep running next/check until next exits 10' }); process.exit(EXIT.USAGE); }
  const tinfo = testCmdInfo(o, root); const tprob = testCmdProblem(tinfo); if (tprob) die(`REFUSED: ${tprob}`);
  const base = runsDir(root, o.change); const fstate = path.join(base, 'finish.json');
  const fs0 = fs.existsSync(fstate) ? JSON.parse(fs.readFileSync(fstate, 'utf8')) : { attempts: 0 };
  if (fs0.attempts >= o.maxAttempts) { printJson({ result: 'exhausted', attempts: fs0.attempts, last_failure: fs0.last_failure, fix: 'stop and report to the user; delete openspec/.apply-runs/<change>/finish.json to allow new attempts' }); process.exit(EXIT.EXHAUSTED); }
  const prevRec = RS.readJson(path.join(base, 'finished.json'));
  const previousFinish = prevRec ? `an earlier finish: ${RS.finishLine(prevRec, RS.fingerprint(CODE_ROOT))}; this run checks everything again` : null;
  if (previousFinish) process.stderr.write(`verify-task: ${previousFinish}\n`);
  const runs = CH.sortRuns(fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d, 'metrics.jsonl'))));
  const run = runs.length ? path.join(base, runs[runs.length - 1]) : currentRun(root, o.change, true);
  PROFILE_RUN = run;
  const t0 = Date.now(); const checks = []; const failures = []; const warnings = [];
  const cmds = [];
  if (tinfo.cmd) cmds.push(['tests', tinfo.cmd, CODE_ROOT]); else warnings.push('project tests were not run (Test command: none)');
  for (const x of EXTRA_CMDS) { const e = extraCmdInfo(root, x); if (e.cmd) cmds.push([x.name, e.cmd, CODE_ROOT]); else if (e.state === 'placeholder') warnings.push(`${x.label} is still <fill in>: ${x.name} was not run`); }
  cmds.push(['validate', `openspec validate '${o.change}' --strict`, root]);
  let testOut = null;
  const treeKey = phaseTree(o);
  const results = await Promise.all(cmds.map(([name, cmd, cwd]) => runNamed(o, root, name, cmd, cwd, treeKey)));
  for (const [i, [name, cmd]] of cmds.entries()) {
    const r = results[i];
    if (name === 'tests') testOut = r.full;
    checks.push({ check: name, ok: r.rc === 0, rc: r.rc, timed_out: r.timedOut, seconds: r.seconds, ...(r.cached ? { cached: true } : {}) });
    if (r.rc !== 0) failures.push(`${name} failed${r.timedOut ? ` (timed out after ${r.limit}s)` : ` (exit ${r.rc})`}: ${cmd}\n${r.tail.slice(-1500)}`);
  }
  const cfg = visualConfig(root);
  const vscens = changeScenarios(changeDir);
  // visual.scope: task -- the checks looked at each task's own scenarios only; the scenarios of the change's other tasks and of
  // the specs it does not change are checked here, once, against the pre-change capture (HEAD).
  const guards = cfg.scope === 'task' && !cfg.off && (changedFiles() || []).some((f) => VC.isUiFile(f, cfg))
    ? VC.scenariosIn(path.join(root, 'openspec/specs')).filter((x) => !vscens.some((y) => y.id === x.id)) : [];
  if ((vscens.length || guards.length) && !cfg.off) {
    const vprob = VC.configProblem(cfg);
    if (vprob) failures.push(`visual check needed (${vscens.length + guards.length} visual scenarios) but ${vprob}`);
    else {
      const outDir = path.join(run, 'visual', `finish-${stamp()}`);
      const declared = changeTaskFiles(taskFiles(j)).map((f) => path.basename(f).replace(/\.[^.]+$/, '').toLowerCase());
      const plan = { cfg, mine: vscens, items: [...vscens.map((x) => ({ scenario: x, role: 'task', inScope: true, shots: false })), ...guards.map((x) => ({ scenario: x, role: 'guard', inScope: !!(x.component && declared.includes(x.component.toLowerCase())), shots: false }))] };
      const rep = await runVisual(o, root, changeDir, plan, null, run, outDir);
      warnings.push(...rep.warnings);
      if (rep.skipped) { checks.push({ check: 'visual', ok: !cfg.require_playwright, skipped: rep.skipped, seconds: rep.seconds }); if (cfg.require_playwright) failures.push(`visual check could not run (${rep.skipped})`); }
      else { checks.push({ check: 'visual', ok: !rep.defects.length, defects: rep.defects.length, seconds: rep.seconds }); if (rep.defects.length) failures.push(`visual check: ${rep.defects.length} defect(s) (report: ${path.join(outDir, 'report.json')}):\n${VC.summarize(rep.defects).join('\n')}`); }
    }
  }
  const tq0 = Date.now(); const t = traceFor(root, changeDir, cfg);
  checks.push({ check: 'trace', ok: !t.res.missing.length, scenarios: t.res.total, tagged: t.res.covered.length, visual: t.res.visual.length, untested: t.res.missing.map((x) => x.id), seconds: (Date.now() - tq0) / 1000 });
  if (t.res.missing.length) failures.push(`${t.res.missing.length} of ${t.res.total} scenarios have no tagged test: ${t.res.missing.map((x) => `[${x.id}]`).join(', ')}. Write (or tag) a test that proves each one. ${TAG_HELP}`);
  const up = checkScope(root, o.change, changeDir); const prob = sizeReport(changeDir).problems.filter((x) => x.kind === 'path-artifacts');
  checks.push({ check: 'path', ok: !prob.length, path: Q.planPath(Q.sizeFacts(changeDir, { upgrade: readUpgrade(changeDir) })).path, ...(up.length ? { upgraded_by: up } : {}) });
  for (const x of prob) failures.push(x.text);
  const cbase = changeBase(root, o.change);
  const touched = cbase ? changedTestFiles(cbase) : null;
  const st = sourceTextCheck(touched || Q.listTestFiles(CODE_ROOT));
  checks.push({ check: 'source_text', ok: !(touched && st.bad.length), files: (touched || []).length, findings: st.bad.length, allowed: st.allowed.length, scope: touched ? `test files changed since ${cbase.slice(0, 12)}` : 'all test files (no recorded base commit: warn only)' });
  if (st.bad.length && touched) failures.push(`tests read source files as text:\n${st.bad.map((x) => '- ' + x).join('\n')}\n${Q.SOURCE_TEXT_FIX}`);
  else if (st.bad.length) warnings.push(...st.bad.map((x) => `source-text test (pre-existing?): ${x}`));
  for (const a of st.allowed) warnings.push(`allowed source-text test: ${a}`);
  if (cbase) { const now = changedFiles(); if (now) addTokenLint(designTokenLint(changeDir, [...new Set([...(gitList(['diff', '--name-only', cbase, '--']) || []), ...now])]), checks, failures, warnings); }
  const nr = whyReport(root, changeDir); let ar = null;
  if (nr.mode !== 'off') {
    checks.push({ check: 'why', ok: !nr.problems.some((x) => x.severity === 'error'), why_owner_approval: nr.approvals.map((a) => a.key) });
    for (const x of nr.problems) (x.severity === 'error' ? failures : warnings).push(`why: ${x.text}`);
    ar = anchorReport(root, changeDir);
    checks.push({ check: 'anchors', ok: !ar.problems.some((x) => x.severity === 'error'), requirements: ar.summary.change_requirements, without_code_anchor: ar.summary.without_code, without_test_anchor: ar.summary.without_test, unresolved: ar.summary.unresolved, stale_tags: ar.summary.stale_tags });
    for (const x of ar.problems) (x.severity === 'error' ? failures : warnings).push(`code anchors: ${x.text}`);
    addGuard(anchorGuardReport(root, changeDir, cbase, 'change', null), nr.mode, checks, failures, warnings);
    const evl = T.evidenceLevel(configFiles(root));
    if (testOut !== null && evl !== 'off' && !t.res.missing.length) {
      const sc = t.scens.filter((x) => !x.visual && x.requirement).map((x) => ({ id: x.id, requirement: `${x.capability}/${Q.slug(x.requirement)}` }));
      const ev = AG.testEvidence(testOut, sc); const failed = [], unlisted = [], passed = [];
      for (const [id, st] of ev.byScenario) (st === 'failed' ? failed : st === 'unlisted' ? unlisted : passed).push(id);
      const strictFail = evl === 'strict' && unlisted.length;
      checks.push({ check: 'test_evidence', ok: !failed.length && !strictFail, passed: passed.length, failed, unlisted: unlisted.length, requirements: Object.fromEntries([...ev.byRequirement].map(([k, v]) => [k, v.failed.length ? 'failed' : v.passed.length && !v.unlisted.length ? 'passed' : v.passed.length ? 'partly-listed' : 'unlisted'])) });
      if (failed.length) failures.push(`tests tagged for these scenarios are failing or skipped in the test output: ${failed.map((x) => `[${x}]`).join(', ')}. An anchored requirement needs a passing test of its scenarios: fix the test or the code (do not skip or delete the test).`);
      if (unlisted.length) (strictFail ? failures : warnings).push(`test evidence: the test output does not name ${unlisted.length} tagged scenario(s) (${unlisted.slice(0, 6).map((x) => `[${x}]`).join(', ')}${unlisted.length > 6 ? ', ...' : ''}), so passing cannot be confirmed from it; the test command exited 0. Use a reporter that prints test names for the finish run${strictFail ? ' (test_evidence: strict)' : ''}.`);
    }
  }
  const seconds = (Date.now() - t0) / 1000;
  for (const w of warnings) process.stderr.write(`verify-task: WARNING: ${w}\n`);
  if (!failures.length) {
    logMetric(run, { event: 'finish', ok: true, attempt: fs0.attempts + 1, seconds, checks });
    if (fs.existsSync(fstate)) fs.unlinkSync(fstate);
    const fp = RS.fingerprint(CODE_ROOT); const rr = RS.readJson(path.join(run, 'run.json')) || {};
    const rec = { at: new Date().toISOString(), run: path.basename(run), session: rr.session || null, ...fp, worktree: CODE_ROOT };
    RS.writeJson(path.join(base, 'finished.json'), rec);
    printJson({ result: 'finished', status: RS.finishLine(rec, fp), ...(previousFinish ? { previous_finish: previousFinish } : {}), checks, seconds, warnings, why_owner_approval: nr.approvals.length ? nr.approvals.map((a) => ({ requirement: a.key, change: a.status, was: a.was, now: a.now })) : undefined, next: `commit, then tell the user: Run /spec-archive ${o.change}; it syncs first (specs, ADRs) and stops if the sync finds a problem.${nr.approvals.length ? ' This change rewrites a Why or removes a requirement: the owner must approve it (' + nr.approvals.map((a) => a.key).join(', ') + ').' : ''}` });
    process.exit(EXIT.OK);
  }
  const attempts = fs0.attempts + 1; const exhausted = attempts >= o.maxAttempts;
  fs.writeFileSync(fstate, JSON.stringify({ attempts, last_failure: failures.map((f) => f.split('\n')[0]) }, null, 2) + '\n');
  logMetric(run, { event: 'finish', ok: false, attempt: attempts, exhausted, seconds, checks, failures: failures.map((f) => f.split('\n')[0]) });
  const fix = path.join(run, `finish-fix-${attempts}.md`);
  fs.writeFileSync(fix, [
    `The OpenSpec change \`${o.change}\` (change directory: \`${path.relative(CODE_ROOT, changeDir) || changeDir}\`) has every task ticked, but its finish check failed (attempt ${attempts} of ${o.maxAttempts}).`,
    'Fix exactly these problems, test-first where a behaviour is missing a test:', '', ...failures.map((f) => `- ${f.replace(/\n/g, '\n  ')}`), '',
    `Read first: ${['proposal.md', 'specs', 'design.md', 'design-map.md', 'tasks.md', 'progress.md'].map((f) => path.join(changeDir, f)).filter((f) => fs.existsSync(f)).map((f) => path.relative(CODE_ROOT, f) || f).join(', ')}.`,
    'The orchestrator re-runs the finish check after you. Do not edit tasks.md, specs or ADRs, and do not commit.',
    'If a problem cannot be fixed without changing the plan or the specs, write BLOCKED.md in the change directory instead.',
    'End your reply with one line: `STATUS: done`, `STATUS: failed` or `STATUS: blocked`.',
  ].join('\n') + '\n');
  printJson({ result: exhausted ? 'exhausted' : 'failed', attempt: attempts, max_attempts: o.maxAttempts, failures, fix_prompt: exhausted ? null : fix, checks, seconds, warnings, next: exhausted ? 'stop and report the failures to the user' : 'dispatch ONE spec-implementer subagent with fix_prompt, commit nothing, then run finish again' });
  process.exit(exhausted ? EXIT.EXHAUSTED : EXIT.FAIL);
}

async function cmdDoctor(o) {
  const root = fs.realpathSync(resolveRoot(o));
  const problems = []; const warnings = [];
  const t = testCmdInfo(o, root); const tp = testCmdProblem(t); if (tp) problems.push(tp);
  if (t.state === 'none') warnings.push('Test command: none — the verifier will not run project tests');
  const cfg = visualConfig(root); const vp = VC.configProblem(cfg); if (vp) problems.push(vp);
  const env = { playwright: null, chromium: null, browsers: null, axe: null, axe_tags: null };
  if (!cfg.off && !vp) {
    const pw = VC.loadPlaywright(CODE_ROOT);
    if (!pw) (cfg.require_playwright ? problems : warnings).push('Playwright is not installed in the code repository: the visual check will be SKIPPED (npm i -D playwright && npx playwright install chromium)');
    else {
      env.playwright = pw.from;
      try {
        const l = await VC.launchChromium(pw, CODE_ROOT, cfg); await l.browser.close(); env.chromium = 'ok';
        env.browsers = { dir: l.found.dir, source: l.found.source };
        if (l.found.executablePath) warnings.push(`Chromium found in ${l.found.dir} (${l.found.source}), not where Playwright looks by default; the visual check uses it automatically. To make that explicit, set visual.browsers_path: ${l.found.dir} or export PLAYWRIGHT_BROWSERS_PATH=${l.found.dir}`);
      } catch (e) {
        env.chromium = String(e.message).split('\n')[0]; env.browsers = { dir: null, searched: (e.found && e.found.searched || []).slice(0, 12) };
        (cfg.require_playwright ? problems : warnings).push(`Chromium cannot be launched (${env.chromium}): run npx playwright install chromium, or set visual.browsers_path (or PLAYWRIGHT_BROWSERS_PATH) to the directory that holds it`);
      }
      env.axe_tags = VC.AXE_TAGS;
      env.axe = VC.axeSource(CODE_ROOT, pw.from) ? 'ok' : null; if (!env.axe) warnings.push('axe-core is not installed: accessibility checks will be skipped (npm i -D axe-core)');
    }
  }
  const roles = cfg.off || vp ? [] : RL.describe(cfg.roles, CODE_ROOT);
  { const tr = spawnSync('git', ['ls-files', '--', RL.LOCAL_FILE, RL.AUTH_DIR], { cwd: CODE_ROOT, encoding: 'utf8' });
    if (tr.status === 0 && tr.stdout.trim()) problems.push(`credentials or sessions are tracked by git: ${tr.stdout.trim().split('\n').join(', ')}; run git rm --cached on them, they must stay local (they are gitignored)`); }
  for (const r of roles) if (!r.ready) warnings.push(`visual role ${r.role}: missing ${r.missing.join(', ')}; scenarios with \`role: ${r.role}\` will fail until it is set`);
  const extra = EXTRA_CMDS.map((x) => extraCmdInfo(root, x));
  for (const e of extra) if (e.state === 'placeholder') warnings.push(`${EXTRA_CMDS.find((x) => x.name === e.name).label} is still <fill in>: set it (e.g. \`npm run ${e.name}\`) or write none`);
  printJson({ ok: !problems.length, root, test_command: t, typecheck_command: extra[0], lint_command: extra[1], visual: { off: cfg.off, source: cfg.source, sources: cfg.sources, command: cfg.command, url: cfg.url, review: cfg.review, require_playwright: cfg.require_playwright, ignore_https_errors: cfg.ignore_https_errors, placeholders: cfg.placeholders, roles }, env, problems, warnings });
  process.exit(problems.length ? EXIT.FAIL : EXIT.OK);
}

/** design-system: what the project already has to build a design with (tokens, components, variants). */
function cmdDesignSystem(o) {
  const ds = DC.discover(CODE_ROOT);
  if (o.formatGiven && o.format === 'json') printJson(ds); else process.stdout.write(DC.formatDesignSystem(ds) + '\n');
  process.exit(EXIT.OK);
}

function cmdStatus(o) {
  const { root } = context(o);
  const j = applyInstructions(root, o.change);
  const run = currentRun(root, o.change, false);
  const st = run && fs.existsSync(path.join(run, 'state.json')) ? readState(run) : null;
  const rec = run && RS.readJson(path.join(run, 'run.json')); const fp = RS.fingerprint(CODE_ROOT);
  const ledger = readLedger(root, o.change, j.tasks);
  const runStatus = rec ? `${RS.describeRun(rec)}; ${RS.ownership(rec, RS.identity(o, CODE_ROOT), Date.now()).foreign ? 'NOT yours (another session or worktree)' : 'yours or unknown owner'}` : 'no open run';
  const finished = RS.readJson(path.join(runsDir(root, o.change), 'finished.json'));
  printJson({ progress: j.progress, next: (j.tasks.find((t) => !t.done) || {}).description || null, run, run_status: runStatus, last_finish: RS.finishLine(finished, fp), verified: Object.keys(ledger.passed), review_pending: st && st.review ? st.review.prompt : null, ambiguous: lintReport(taskFiles(j)) });
}

function planProblems(files, changeDir) {
  const prop = changeDir ? path.join(changeDir, 'proposal.md') : null;
  const size = prop && fs.existsSync(prop) ? Q.proposalSize(fs.readFileSync(prop, 'utf8')).size : null;
  const review = size ? Q.planPath(Q.sizeFacts(changeDir, { upgrade: readUpgrade(changeDir) })).review : undefined;
  return files.filter((f) => fs.existsSync(f)).flatMap((f) => Q.planLint(fs.readFileSync(f, 'utf8'), { size, review }).problems.map((p) => ({ file: f, ...p, text: `${path.basename(f)}:${p.line}: ${p.text}` })));
}
/** Declared size (proposal.md) vs what the change's specs, ADRs and tasks need (quality.cjs sizeCheck). */
function sizeReport(changeDir) {
  const facts = Q.sizeFacts(changeDir, { upgrade: readUpgrade(changeDir) }); const r = Q.sizeCheck(facts);
  return { ...r, facts, problems: r.problems.map((p) => ({ ...p, file: path.join(changeDir, p.file), text: `${p.file}:${p.line}: ${p.text}` })) };
}
/** `app-map <change> [--apply]`: the two-line app map of a Size S change, from its specs (no agent writes it). */
function cmdAppMap(o) {
  const { root, changeDir } = context(o);
  const f = Q.sizeFacts(changeDir);
  if (!f.has_proposal || f.declared !== 'S') die('app-map is generated only for a Size S change: M and L write the full app map');
  const text = Q.appMapText(changeDir, path.join(root, 'openspec', 'specs'));
  if (o.apply) fs.writeFileSync(path.join(changeDir, 'app-map.md'), text);
  printJson({ ok: true, written: !!o.apply, text });
  process.exit(EXIT.OK);
}
function cmdSize(o) {
  const { changeDir } = context(o);
  const r = sizeReport(changeDir); const f = r.facts;
  const ok = isSpecOnly(changeDir) || !r.problems.some((p) => p.severity === 'error');
  printJson({ ok, kind: isSpecOnly(changeDir) ? 'spec-only' : undefined, declared: r.declared, required: r.required, path: r.path.path, path_reasons: r.path.reasons, review_required: r.path.review, reasons: r.reasons, task_cap: Q.CAPS[r.declared || r.required], facts: { capabilities: f.capabilities, requirements: f.requirements, visual_blocks: f.visual_blocks, breaking: f.breaking, risk: f.risk, risky_groups: f.risky_groups, adrs: f.adrs }, problems: r.problems });
  process.exit(ok ? EXIT.OK : EXIT.FAIL);
}
/** Size, edge-case, why, task-format, invariant and purpose findings of a change (what `lint` prints under `plan`). */
const proposalText = (changeDir) => { try { return fs.readFileSync(path.join(changeDir, 'proposal.md'), 'utf8'); } catch (e) { return ''; } };
/** `Kind: spec-only` (traceability.cjs): the change only writes specs; size caps and task-plan lints do not apply. */
const isSpecOnly = T.isSpecOnly;
/** `Slice: <id>` in proposal.md: the change builds one roadmap slice from specs that already exist; it must not carry delta specs. */
const sliceOf = (changeDir) => { const m = proposalText(changeDir).match(/^\s*(?:[-*]\s+)?\**Slice\**:\s*`?([a-z0-9][a-z0-9-]*)`?/mi); return m ? m[1] : null; };
function sliceProblems(changeDir) {
  const id = sliceOf(changeDir); if (!id) return [];
  const deltas = fs.existsSync(path.join(changeDir, 'specs')) && fs.readdirSync(changeDir + '/specs').length;
  return deltas ? [{ line: 1, severity: 'error', kind: 'slice-with-specs', file: 'proposal.md', text: `slice ${id}: a slice change builds what the specs already say; it carries no specs/ delta (amend the specs with a separate change first)` }] : [];
}
function planReport(root, changeDir, files, vl) {
  const sz = sizeReport(changeDir);
  const edge = Q.edgeLint(changeDir, { visual: new Map(vl.scenarios.map((x) => [x.id, x])) });
  const nr = whyReport(root, changeDir);
  const invariant = Q.invariantLint(path.join(changeDir, 'specs')).map((p) => ({ ...p, text: `specs/${p.text}` })); const purpose = [...Q.purposeLint(changeDir, path.join(root, 'openspec', 'specs')), ...Q.thenLint(changeDir)];
  const ux = Q.uxLint(changeDir, { visual: new Map(vl.scenarios.map((x) => [x.id, x])) }).map((p) => ({ ...p, file: path.join(changeDir, p.file) }));
  const plan = isSpecOnly(changeDir) ? [...nr.problems, ...invariant, ...purpose, ...ux]
    : [...sz.problems, ...nr.problems, ...planProblems(files, changeDir), ...invariant, ...edge.problems.map((p) => ({ ...p, file: path.join(changeDir, p.file) })), ...purpose, ...ux, ...sliceProblems(changeDir)];
  return { sz, edge, nr, plan };
}
function cmdLint(o) {
  const { root, changeDir } = context(o);
  const files = taskFiles(applyInstructions(root, o.change));
  const bad = lintReport(files);
  const vl = visualLint(root, changeDir, files);
  const config = [testCmdProblem(testCmdInfo(o, root)), vl.scenarios.length ? VC.configProblem(visualConfig(root)) : null].filter(Boolean);
  const { sz, edge, nr, plan } = planReport(root, changeDir, files, vl);
  const ok = !bad.length && !vl.problems.some((p) => p.severity !== 'info') && !plan.some((p) => p.severity === 'error') && !config.length;
  printJson({ ok, traceability: nr.mode, why_owner_approval: nr.mode === 'off' ? undefined : nr.approvals.map((a) => a.key), size: { declared: sz.declared, required: sz.required, task_cap: Q.CAPS[sz.declared || sz.required] }, edge_cases: edge.items.map((x) => ({ text: x.text, scenarios: x.ids })), problems: bad, visual: vl.problems, visual_scenarios: vl.scenarios.map((x) => x.id), plan, config });
  process.exit(ok ? EXIT.OK : EXIT.FAIL);
}

// ---------- traceability: why, code anchors, drift, sync (traceability.cjs) ----------
const traceMode = (root) => T.mode(configFiles(root));
const rootOf = (o) => fs.realpathSync(resolveRoot(o));
const asProblem = (p) => ({ ...p, text: p.kind === 'missing-why' || p.kind === 'why-too-short' ? p.text : (p.file && p.line ? `${p.file}:${p.line}: ${p.text}` : p.text) });
/** Why findings of a change, severities per the traceability mode. */
function whyReport(root, changeDir) {
  const md = traceMode(root); const r = T.whyLint(root, changeDir);
  return { mode: md, ...r, problems: T.bySeverity(r.problems, md).map(asProblem) };
}
/** Anchor findings of a change (unresolved markers, missing code/test anchors, stale tags), severities per the mode. */
function anchorReport(root, changeDir) {
  const md = traceMode(root); const r = T.anchorLint(root, changeDir, CODE_ROOT);
  return { mode: md, ...r, problems: T.bySeverity(r.problems, md) };
}
/** `anchors prune`: the markers `anchor_fit` flags as removable. Without --apply: the list. With --apply: those marker lines are removed (all, or --select file:line). The last anchor of a requirement stays. */
function cmdAnchorsPrune(o) {
  const root = rootOf(o); const fit = T.fitProblems(root, CODE_ROOT, null);
  const all = T.scanAnchors(CODE_ROOT); const left = new Map(); for (const m of all) if (!Q.isTestPath(m.file)) left.set(m.key, (left.get(m.key) || 0) + 1);
  const candidates = fit.findings.filter((x) => x.remove);
  const want = o.select ? o.select.map((x) => { const m = x.match(/^(.*):(\d+)$/); return m ? { file: m[1], line: Number(m[2]) } : die(`--select wants <file>:<line>, got '${x}'`); }) : null;
  const picks = []; const refused = [];
  for (const x of want ? want.map((w) => ({ w, f: fit.findings.find((c) => c.file === w.file && c.line === w.line) })).map(({ w, f }) => f || { file: w.file, line: w.line, none: true }) : candidates) {
    if (x.none) { refused.push({ file: x.file, line: x.line, why: 'not an over-anchored marker (anchor_fit has no finding there)' }); continue; }
    if (x.kind === 'many-anchors') { refused.push({ file: x.file, line: x.line, key: x.key, why: 'an info line about the count, not a marker to remove: anchors that pass the fit stay' }); continue; }
    if (!x.remove) { refused.push({ file: x.file, line: x.line, key: x.key, why: 'it is the requirement\'s only code anchor: move it, do not remove it' }); continue; }
    if ((left.get(x.key) || 0) <= 1) { refused.push({ file: x.file, line: x.line, key: x.key, why: 'would leave the requirement without a code anchor' }); continue; }
    left.set(x.key, left.get(x.key) - 1); picks.push({ file: x.file, line: x.line, key: x.key, kind: x.kind });
  }
  const texts = {}; for (const f of new Set(picks.map((x) => x.file))) texts[f] = fs.readFileSync(path.join(CODE_ROOT, f), 'utf8');
  const next = FIT.removeMarkers(texts, picks); let removed = 0;
  if (o.apply) for (const [f, t] of Object.entries(next)) { if (t !== texts[f]) { fs.writeFileSync(path.join(CODE_ROOT, f), t); removed += picks.filter((x) => x.file === f).length; } }
  printJson({ ok: true, level: fit.level, max: fit.max, applied: !!o.apply, removable: picks, removed, refused, note: o.apply ? 'marker lines removed; run `verify-task.cjs drift` to see what is left' : 'nothing changed: add --apply to remove these markers (or --select file:line,... to pick)' });
  process.exit(EXIT.OK);
}
function cmdAnchors(o) {
  if (o.sub === 'prune') return cmdAnchorsPrune(o);
  const root = rootOf(o); const md = traceMode(root);
  const changeDir = o.change ? path.join(root, 'openspec/changes', o.change) : null;
  if (changeDir && !fs.existsSync(changeDir)) die(`change '${o.change}' not found under ${root}/openspec/changes`);
  const r = T.anchorLint(root, changeDir || path.join(root, 'openspec/.none'), CODE_ROOT);
  const problems = T.bySeverity(r.problems, md === 'off' ? 'on' : md);
  const reqs = {}; for (const [k, x] of r.facts.requirements) reqs[k] = { code: [...x.code].sort(), tests: [...x.tests].sort() };
  printJson({ ok: !problems.some((p) => p.severity === 'error'), mode: md, summary: r.summary, problems, ...(o.json ? { index: T.anchorIndex(r.eff, r.facts) } : {}), requirements: o.change ? Object.fromEntries(Object.entries(reqs).filter(([k]) => r.mine.includes(k))) : reqs });
  process.exit(problems.some((p) => p.severity === 'error') ? EXIT.FAIL : EXIT.OK);
}
/** `adrs`: list the promoted ADRs and check their numbers are unique; --fix renumbers duplicates (parallel branches). */
function cmdAdrs(o) {
  const root = rootOf(o); let renamed = [];
  if (o.fix) renamed = T.adrRenumber(root);
  const dup = T.adrDuplicates(root);
  printJson({ ok: !dup.length, adrs: T.adrList(root).map((a) => ({ number: a.number, slug: a.slug, title: a.title, status: a.status, source: a.source || undefined })), duplicates: dup, renamed: renamed.length ? renamed : undefined, next: dup.length ? 'two ADRs share a number: run `adrs --fix` (the first file keeps it) and commit the renames' : renamed.length ? 'commit the renames; check that any `supersedes:` that named a renumbered ADR still points at the right one' : undefined });
  process.exit(dup.length ? EXIT.FAIL : EXIT.OK);
}
/** `guard <change> [--base REF]`: the anchor guard over the change's diff (default base: the commit `next` recorded; else HEAD). */
function cmdGuard(o) {
  const { root, changeDir } = context(o);
  const base = o.base || changeBase(root, o.change) || 'HEAD';
  const rep = anchorGuardReport(root, changeDir, base, 'change', null);
  if (!rep) { printJson({ ok: true, level: 'off', note: 'anchor guard is off (anchor_guard: off or traceability: off)' }); process.exit(EXIT.OK); }
  printJson({ ok: !(rep.level === 'error' && rep.findings.length), level: rep.level, base, files: rep.files, findings: rep.findings });
  process.exit(rep.level === 'error' && rep.findings.length ? EXIT.FAIL : EXIT.OK);
}
function driftText(r) {
  const L = [`drift: ${r.requirements} requirement(s); ${r.open.filter((x) => (x.severity || 'error') === 'error').length} open gap(s) (+${r.open.filter((x) => (x.severity || 'error') !== 'error').length} advisory), ${r.accepted.length} accepted`];
  for (const g of r.open.filter((x) => (x.severity || 'error') === 'error')) L.push(`  OPEN     ${g.key}\n           ${g.text}${g.hint ? `\n           hint: ${g.hint}` : ''}`);
  for (const g of r.open.filter((x) => (x.severity || 'error') !== 'error')) L.push(`  ${g.severity.toUpperCase().padEnd(8)} ${g.key}  (advisory: does not fail drift)\n           ${g.text}${g.hint ? `\n           hint: ${g.hint}` : ''}`);
  for (const n of r.notes || []) L.push(`  note: ${n}`);
  if (r.observed && r.observed.entries) L.push(`  observed, unconfirmed: ${r.observed.entries} open entr${r.observed.entries === 1 ? 'y' : 'ies'} in ${r.observed.files} file(s) under openspec/observed/ (each waits for its owner; none is a requirement)`);
  for (const g of r.accepted) L.push(`  accepted ${g.key}  (${g.accepted})`);
  return L.join('\n');
}
function cmdDrift(o) {
  const root = rootOf(o); const md = traceMode(root);
  if (o.sub === 'decide') {
    if (!o.accept) die('drift decide only records `--accept --note TEXT`: a gap you do not accept is fixed (the hint of each gap in `drift` says how)');
    if (!o.all && !o.key) die('drift decide <gap-key> --accept --note TEXT   (gap keys: see `drift`); or --all <gap-type> --accept --note TEXT to accept every open gap of one type, e.g. --all unanchored-requirement');
    const rep = T.drift(root, CODE_ROOT);
    if (o.all && !T.ACCEPTABLE.includes(o.all)) die(`only ${T.ACCEPTABLE.join(', ')} gaps can be accepted; a ${o.all} gap is fixed or removed (see its hint in \`drift\`)`);
    const gaps = o.all ? rep.open.filter((g) => g.type === o.all) : rep.gaps.filter((g) => g.key === o.key);
    if (!o.all && !gaps.length) die(`no gap '${o.key}' (keys look like unanchored-requirement:todo/add-a-todo; run \`drift\`)`);
    let res; try { res = T.accept(root, gaps, o.note); } catch (e) { die(e.message); }
    const stale = gaps.some((g) => g.type === 'stale-anchor') && res.some((x) => !x.changed);
    printJson({ accepted: res, changed: res.filter((x) => x.changed).length, next: stale ? 'a stale-anchor clears when the requirement text changes in a commit: this line was already there with this reason; use a new reason' : 'commit the spec change; the gaps are listed as accepted' });
    process.exit(EXIT.OK);
  }
  if (o.sub) die(`unknown drift subcommand '${o.sub}'`);
  const r = T.drift(root, CODE_ROOT);
  const gap = (g) => ({ key: g.key, type: g.type, severity: (g.severity || 'error') === 'error' ? undefined : g.severity, accepted: g.accepted, text: g.text, hint: g.hint || undefined, files: g.files && g.files.length ? g.files : undefined, requirements: g.requirements, line: g.type === 'over-anchored' ? g.line : undefined, fit: g.fit, removable: g.removable });
  const errOpen = r.open.filter((x) => (x.severity || 'error') === 'error'); const advisory = r.open.filter((x) => (x.severity || 'error') !== 'error');
  const bad = errOpen.length;
  if (o.text) process.stdout.write(driftText(r) + '\n');
  else printJson({ ok: !bad, mode: md, requirements: r.requirements, counts: r.counts, observed: r.observed && r.observed.entries ? r.observed : undefined, open: errOpen.map(gap), advisory: advisory.length ? advisory.map(gap) : undefined, notes: r.notes && r.notes.length ? r.notes : undefined, accepted: r.accepted.map(gap), next: bad ? 'run /spec-garden: fix each gap by its hint, or accept the ones that belong to a requirement (`verify-task.cjs drift decide <key> --accept --note "why"`)' : 'no drift' });
  process.exit(bad ? EXIT.FAIL : EXIT.OK);
}
/**
 * `problems [<change>] [--json]`: every finding of the verifier as one located list (problems.cjs), for editors: lint of the active changes
 * (or the one named), drift gaps (placement and stale anchors included), the anchor guard of changes that have begun. Read-only; exit 0.
 */
function cmdProblems(o) {
  const root = rootOf(o); const md = traceMode(root);
  const changesDir = path.join(root, 'openspec/changes');
  const names = o.change ? [o.change] : (fs.existsSync(changesDir) ? fs.readdirSync(changesDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'archive' && !d.name.startsWith('.')).map((d) => d.name).sort() : []);
  const findings = []; const notes = [];
  for (const change of names) {
    const changeDir = path.join(changesDir, change);
    if (!fs.existsSync(changeDir)) die(`change '${change}' not found under ${root}/openspec/changes`);
    const ctx = { change, changeDir, codeRoot: CODE_ROOT, root };
    try {
      const tasks = path.join(changeDir, 'tasks.md');
      const files = fs.existsSync(tasks) ? [tasks] : [];
      const vl = visualLint(root, changeDir, files);
      const { plan } = planReport(root, changeDir, files, vl);
      findings.push(...PR.lintFindings([...plan, ...vl.problems.map((p) => ({ ...p, file: p.file || tasks }))], ctx));
      const base = changeBase(root, change);
      const rep = base ? anchorGuardReport(root, changeDir, base, 'change', null) : null;
      if (rep) findings.push(...PR.guardFindings(rep.findings, { ...ctx, level: rep.level }));
    } catch (e) { notes.push(`${change}: ${String(e.message || e).split('\n')[0]}`); }
  }
  if (md !== 'off') {
    const r = T.drift(root, CODE_ROOT);
    const reqs = T.livingRequirements(root);
    // Markers and test tags for requirements/scenarios that a change in progress adds are not orphans yet (`check` accepts them too).
    const pendReq = new Set(); const pendScn = new Set();
    const activeDirs = fs.existsSync(changesDir) ? fs.readdirSync(changesDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'archive' && !d.name.startsWith('.')).map((d) => path.join(changesDir, d.name)) : [];
    for (const dir of activeDirs) for (const d of T.changeDeltas(dir)) {
      for (const rn of d.renames) pendReq.add(`${d.cap}/${rn.toSlug}`);
      for (const q of d.reqs) if (q.op === 'ADDED' || q.op === 'MODIFIED') { pendReq.add(`${d.cap}/${q.slug}`); for (const sc of q.scenarios) pendScn.add(`${d.cap}/${sc.slug}`); }
    }
    const inPending = (g) => (g.type === 'orphan-anchor' && pendReq.has(String(g.subject).split('@')[0])) || (g.type === 'stale-test-tag' && pendScn.has(String(g.subject)));
    findings.push(...PR.driftFindings(r.open.filter((g) => !inPending(g)), { codeRoot: CODE_ROOT, root, reqs }));
    notes.push(...(r.notes || []));
  }
  const list = PR.finish(findings);
  printJson({ ok: !list.some((f) => f.severity === 'error'), mode: md, counts: { error: list.filter((f) => f.severity === 'error').length, warning: list.filter((f) => f.severity === 'warning').length, info: list.filter((f) => f.severity === 'info').length }, findings: list, notes: notes.length ? notes : undefined });
  process.exit(EXIT.OK);
}
function cmdSyncCheck(o, quiet) {
  const { root, changeDir } = context(o); const md = traceMode(root);
  const r = T.syncCheck(root, changeDir, o.change, CODE_ROOT, md);
  const out = { synced: r.ok, mode: md, parts: r.parts, problems: r.problems, warnings: r.warnings, next: r.ok ? `archive with /spec-archive ${o.change} (it syncs first; the script \`archive ${o.change}\` archives only a synced change)` : `NOT SYNCED: /spec-archive ${o.change} syncs first (merges the delta specs, promotes the ADRs) and stops at the problems listed. Run /spec-sync ${o.change} on its own only to inspect or fix them. Do not archive by hand.` };
  if (quiet) return out;
  printJson(out); process.exit(r.ok ? EXIT.OK : EXIT.FAIL);
}
async function cmdArchive(o) {
  const { root, changeDir } = context(o);
  if (fs.existsSync(path.join(changeDir, 'BLOCKED.md'))) { printJson({ result: 'refused', problem: 'BLOCKED.md exists: run /spec-fix first' }); process.exit(EXIT.BLOCKED); }
  const j = applyInstructions(root, o.change); const open = j.tasks.filter((t) => !t.done);
  if (open.length) { printJson({ result: 'refused', problem: `${open.length} task(s) are not done: finish /spec-apply (or /spec-fix) first`, tasks: open.map((t) => t.description) }); process.exit(EXIT.FAIL); }
  const r = cmdSyncCheck(o, true);
  if (!r.synced) { process.stderr.write(`verify-task: REFUSED: change '${o.change}' is NOT SYNCED, so it is not archived. ${r.problems.length} problem(s):\n${r.problems.map((x) => `  - ${x}`).join('\n')}\n/spec-archive runs /spec-sync itself first; this refusal comes from calling the script directly. Run /spec-sync ${o.change} on its own only to inspect or fix the problem(s) above.\n`); printJson({ result: 'refused', ...r }); process.exit(EXIT.FAIL); }
  const created = CH.createdStamp(changeDir); // before the folder moves
  const res = await runCmd(`openspec archive '${o.change}' --skip-specs --yes`, root, o.timeout, 'archive');
  let archivedAt = null;
  if (res.rc === 0) { const ad = CH.archivedDirOf(path.join(root, 'openspec', 'changes', 'archive'), o.change); if (ad) archivedAt = CH.writeArchived(ad, created).archived_at; }
  tl({ event: 'archive', ok: res.rc === 0, seconds: Math.round((Date.now() - T_START) / 100) / 10, summary: res.rc === 0 ? `archived${archivedAt ? ` at ${archivedAt}` : ''}` : `archive failed (rc ${res.rc})`, details: res.rc === 0 ? undefined : { output_tail: res.tail } });
  if (res.rc === 0) { const ad = CH.archivedDirOf(path.join(root, 'openspec', 'changes', 'archive'), o.change); if (ad) TL.keep(runsDir(root, o.change), ad); } // the folder name has a day only: record the time
  printJson({ result: res.rc === 0 ? 'archived' : 'failed', rc: res.rc, ...(archivedAt ? { archived_at: archivedAt } : {}), output_tail: res.tail, sync: r.parts, warnings: r.warnings, next: res.rc === 0 ? 'the archive move is left uncommitted for you to review' : 'see output_tail' });
  process.exit(res.rc === 0 ? EXIT.OK : EXIT.FAIL);
}

// Timing (--timing): the scans that read the tree or run git, by name.
const wrapT = (label, f) => (...a) => RS.timed(label, () => f(...a));
whyReport = wrapT('scan: why', whyReport); anchorReport = wrapT('scan: anchors', anchorReport); anchorGuardReport = wrapT('scan: anchor guard (git blame)', anchorGuardReport);
sourceTextCheck = wrapT('scan: source-text tests', sourceTextCheck); designTokenLint = wrapT('scan: design tokens', designTokenLint); checkScope = wrapT('scan: path and scope', checkScope);
sizeReport = wrapT('scan: size', sizeReport); traceFor = wrapT('scan: traceability', traceFor); visualPlan = wrapT('visual plan', visualPlan); qualityChecks = wrapT('task quality scans (all)', qualityChecks);
runVisual = wrapT('visual check', runVisual); changedTestFiles = wrapT('git: changed test files', changedTestFiles);
if (['mode', 'greenfield', 'roadmap', 'handover'].includes(process.argv[2])) { require('./greenfield.cjs').main(process.argv.slice(2)); return; }
const o = parseArgs(process.argv.slice(2));
// --timing / SPEC_PROFILE=1: what every command and scan cost, most expensive first, on stderr and in the run's metrics.jsonl.
let PROFILE_RUN = null;
if (o.timing || process.env.SPEC_PROFILE) {
  process.on('exit', () => {
    const steps = RS.profile(); if (!steps.length) return;
    process.stderr.write(`verify-task: timing (${o.cmd}): ${steps.slice(0, 12).map((s) => `${s.step} ${s.seconds}s${s.n > 1 ? ` (${s.n}x)` : ''}`).join(' | ')}\n`);
    if (PROFILE_RUN) try { logMetric(PROFILE_RUN, { event: 'profile', cmd: o.cmd, steps }); } catch (e) { /* run dir gone */ }
  });
}
if (['next', 'check', 'review', 'finish'].includes(o.cmd) && o.change) {
  guardRun(o);
  if (o.cmd !== 'review') {
    const { root, changeDir } = context(o); const run = currentRun(root, o.change, false);
    const task = (() => { try { const st = readState(run); return st.task && st.task.label; } catch (e) { return undefined; } })();
    TL.decide(runsDir(root, o.change), changeDir, { reason: o.reason, session: o.session || process.env.SPEC_SESSION || null, cmd: o.cmd, task });
    if (o.cmd !== 'next') tl({ event: `${o.cmd}-start`, task: o.cmd === 'check' ? task : undefined, summary: o.cmd === 'check' ? `checking ${task || 'the task'}` : 'verifying the whole change' });
  }
}
({ next: cmdNext, check: cmdCheck, status: cmdStatus, lint: cmdLint, size: cmdSize, 'app-map': cmdAppMap, review: cmdReview, visual: cmdVisual, finish: cmdFinish, doctor: cmdDoctor, 'design-system': cmdDesignSystem, anchors: cmdAnchors, adrs: cmdAdrs, drift: cmdDrift, guard: cmdGuard, problems: cmdProblems, sync: cmdSyncCheck, 'sync-check': cmdSyncCheck, archive: cmdArchive })[o.cmd](o);
