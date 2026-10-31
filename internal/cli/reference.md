The wingman-spec reference: the apply loop, what each check does, exit codes, run state and configuration.

APPLY LOOP (the orchestrating agent drives it; a subagent implements; the CLI decides)
  next <change> --format prompt   hand out one dispatch: the whole change at Size S, one task group at M/L, a review task alone,
                                  one task with --per-task; tasks of one group with disjoint Files: come as a parallel WAVE of up
                                  to `parallel:` packets (default 3). next records the pre-task state of the task's visual scenarios.
  check <change> --reported done|failed|blocked [--task <label>]   verify the dispatch and tick it on a pass
  review <change> --reply FILE | --reviewer none   record the spec-visual-reviewer's verdict after exit 5
  finish <change>                 after the last task: full commands, validate, every visual scenario, traceability, test evidence
  visual <change> [--scenario ID] the implementer's own visual check, any time
  Pass --session <id> (or WINGMAN_SPEC_SESSION) on every call: one id per agent conversation.

EXIT CODES
  0 ok   1 failed or rejected   2 usage, setup or refusal (unverified-ticks, run-owned, busy)   3 BLOCKED.md exists
  4 attempts used up (--max-attempts, default 3)   5 visual review pending   6 not allowed in this project mode   10 all tasks done
  5 and 10 are results: never chain wingman-spec calls with &&.

WHAT check RUNS (each command with a timeout, --timeout or WINGMAN_SPEC_TIMEOUT_<NAME>)
  - tasks.md differs from its pre-task snapshot only by the dispatch's own ticks (the CLI ticks; agents never do);
  - every Done when: command of the dispatch;
  - the project commands (commands.test, typecheck, lint) at commands.check_level: targeted (default: the task's targeted tests,
    typecheck and lint at the end of a group), group, task, or finish (nothing until finish); commands.test_run: finish moves the
    project tests to finish. A passing result is reused while the tree and the command are unchanged (--no-cache, WINGMAN_SPEC_NO_CACHE=1);
  - test quality: changed tests must not read source files as text; each scenario the Spec: line names needs a test tagged
    [capability/scenario-slug] or an @spec marker;
  - anchors: placement, the anchor guard (anchored code changed without its requirement being mentioned: update the delta, or add
    `Reviewed anchors: <cap>/<req> - <why it still holds>` to tasks.md or progress.md), anchor fit;
  - validate; the visual check for a task with a Visual: line or changed UI files.
  Fast path (Size S, Risk: none, no sensitive path, no UI, no dependency manifest): no app-map, design or ADR; check and finish
  upgrade a change whose edits leave that scope (runs/<change>/upgrade.json).

PLANNING (lint <change>, size <change>, validate <change>; no command runs)
  proposal.md starts with `Size: S|M|L` and `Risk: none|<kinds>` (security, money, data-migration, concurrency, public-api).
  S = 1 capability, at most 3 requirements, nothing BREAKING, no risk, no ADR, no visual scenarios; M = up to 2 capabilities, or UI
  with visual scenarios; L = 3 or more capabilities, BREAKING, a risk, or a (risky) group. Task caps S/M/L: 3/5/8 implementation tasks.
  One final review task; group reviews only after group 1 of an L change and after groups marked (risky); no close-out tasks.
  Tasks: `## N. Group`, `- [ ] N.M ...` with Spec:, Test first:, Files:, Done when: (a command in backticks), Visual: <ids>|all for UI,
  optional After: <label> (needs that task's result). Delta specs: ## ADDED / MODIFIED / REMOVED / RENAMED (`- Old -> New`).

VISUAL CHECK (visual: in wingman-spec.yaml; scenarios are ```visual blocks)
  Block keys: route:, key:, state: with do: steps, viewports: (default 375/768/1280), reference:, overlay:, component:, expect:,
  role:, absent:, redirects-to:, ignore:, ignore-http:. The app is started from visual.command and probed at visual.url.
  It fails on console and page errors, failed requests, axe violations, sideways scrolling, broken images, and key elements that
  are missing, hidden, off-screen or overlapping; against the pre-task capture also on new defects or ARIA changes outside the task.
  Certificate errors are ignored by default (visual.ignore_https_errors). Without Playwright the check is skipped with a WARNING
  (never report it as passed); visual.require_playwright: true fails instead. Nothing is stored in the repository (no baselines).
  ignore: / ignore-http: (or visual.ignore / visual.ignore_http) skip defects the change does not own: a11y:*, runtime:*, content:*
  and layout:horizontal-overflow only; listed as "ignored (n)".
  Roles (visual.roles): `role: admin` logs in first; the user and password come from WINGMAN_ROLE_<NAME>_USER / _PASSWORD, the
  user_env/password_env names, or the gitignored .wingman-spec/local/roles.yaml. Never write credentials in wingman-spec.yaml.

TRACEABILITY (traceability: on|warn|off)
  Every ADDED or MODIFIED requirement has `Why: <who wants it, and why>` under its SHALL sentence. Rewriting a living Why or removing a
  requirement needs `Owner approval: <name>, <date>` in proposal.md (lint fails until then; finish lists why_owner_approval).
  `@spec <capability>/<requirement-slug>` in one comment on the deciding function, and in the test (or a [capability/scenario-slug] tag).
  anchor_placement, anchor_guard, anchor_fit: warn|error|off; test_evidence: warn|strict|off; anchor_stale: info|warn|error|off.
  drift lists the gaps; `drift decide <key> --accept --note TEXT` (or --all <type>) writes an Accepted: line on the requirement.
  Adopted specs (Purpose says `Baseline: adopted <date>`): a requirement without Why: needs `Confirmed: test <file>: <name> | doc
  <file> | owner <name>, <date>`; unconfirmed behaviour goes to observed/<capability>.md (Observed, Why unconfirmed, Owner, To confirm).

RUN STATE (gitignored, never committed)
  runs/<change>/ in the specs root: one folder per run (run.json owner and commit, state.json, metrics.jsonl, pre/, visual/), plus
  verified.json (every passing task), finished.json (the last passing finish) and timeline.jsonl (kept when the change is archived).
  The timeline records planning commands, artifact edits and `log <change> start|explore|grill|approval|note "<summary>"`.
  Each line has prev, the SHA-256 of the line before; validate and doctor warn when the chain is broken. See docs/timeline.md.
  One live next/check/review/finish per change (busy); a run of another session or worktree idle for less than 30 minutes is refused
  (run-owned); --takeover adopts it. Every result carries run_status.

CONFIGURATION
  .wingman-spec/wingman-spec.yaml (next to the code), or wingman-spec.yaml at a specs repository's root. A code repository linked to a
  specs repository says `specs: <path>` and keeps its own commands:. Lookup order: flag or env > the code repository's file > the
  specs root's file. Unknown keys are errors. `config` prints the merged result; `doctor` lists what is missing.
