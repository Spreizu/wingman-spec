# Harness support: Claude Code, Cursor, Codex

Researched 2026-10-21 from the official docs linked below (Codex hooks page re-read for the hook config shape:
`{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":...}]}]}}`, git-root-relative command paths,
`/hooks` trust review). This decides how the package maps its
workflow (commands, skills, the implementer subagent, the prompt guard) onto each harness. The apply loop
itself is harness-independent: the main agent orchestrates, a subagent implements one task, and the shared
script `openspec/scripts/verify-task.cjs` (plain Node, no harness dependency) decides whether the task is done.

## Capability matrix

| Capability | Claude Code | Cursor (IDE, CLI, Cloud) | Codex (CLI, IDE, app) |
|------------|-------------|--------------------------|-----------------------|
| Project instructions | `CLAUDE.md` (reads `AGENTS.md` only if imported) | `AGENTS.md`, `.cursor/rules/` | `AGENTS.md` (root and nested) |
| Slash commands | `.claude/commands/<name>.md` (still supported; merged into skills) or `.claude/skills/<name>/SKILL.md`, invoked as `/name` | `.cursor/commands/<name>.md`, invoked as `/name`; skills also invocable as `/skill-name` | No project-level commands. Skills are invoked by name (`$skill` / `/skills`), or implicitly from their description |
| Skills (Agent Skills standard) | `.claude/skills/` | `.cursor/skills/`, `.agents/skills/`; also loads `.claude/skills/` and `.codex/skills/` for compatibility | `.agents/skills/` (repo), `~/.agents/skills/` |
| Custom subagents | `.claude/agents/<name>.md` (YAML `name`, `description`, optional `tools`, `model`, `maxTurns`, `skills`, ...) | `.cursor/agents/<name>.md` (`name`, `description`, `model`, `readonly`, `is_background`); also loads `.claude/agents/` and `.codex/agents/`, and `.cursor/` wins on a name clash | `.codex/agents/<name>.toml` (`name`, `description`, `developer_instructions`, optional `model`, `model_reasoning_effort`) |
| How delegation is triggered | Task/Agent tool, automatic from the description or by name | Task tool, automatic from the description or by name | When the user, `AGENTS.md` or a skill asks ("spawn one agent per task"). `/subagents` in the CLI shows threads |
| Subagent context | Fresh context; system prompt from the agent file plus the delegation message; loads CLAUDE.md | Fresh context window; returns a result to the parent | Own thread; inherits the parent's sandbox, approvals, provider and MCP servers (an agent file cannot override them) |
| Prompt hook (guard) | `UserPromptSubmit` in `.claude/settings.json`; block with `{"decision":"block","reason":...}` | `beforeSubmitPrompt` in `.cursor/hooks.json`; block with `{"continue":false,"user_message":...}` | `UserPromptSubmit` in `.codex/hooks.json`; block with `{"decision":"block","reason":...}`. Project hooks load only for **trusted** projects |
| Per-subagent limits | `maxTurns`, `tools`/`disallowedTools` | `readonly` | `features.*` toggles (e.g. `shell_tool = false`); sandbox inherited, cannot be set per agent |
| Subagent can view a PNG on disk | Yes: the Read tool returns images to the model | Yes: the Read files tool supports `.png/.jpg/.gif/.webp/.svg` for vision models | Yes: built-in `view_image` (local path; reads go through the filesystem sandbox; `features.view_image` can disable it, also for subagents) |

## Decisions for this package

1. **One source, generated wrappers.** `harness/commands/*.md` (front matter `description`, `argument-hint`, then a
   harness-neutral body) and `harness/agents/spec-implementer.md` are the single source. `scripts/render-harness.sh` renders:
   - Cursor: `.cursor/commands/<name>.md` (body only), `.cursor/agents/spec-implementer.md`, `.cursor/skills/<skill>/`.
   - Claude Code: `.claude/commands/<name>.md` (front matter + body), `.claude/agents/spec-implementer.md`, `.claude/skills/<skill>/`.
   - Codex: `.agents/skills/<name>/SKILL.md` (one skill per workflow command, since Codex has no project commands),
     `.agents/skills/<skill>/` for the bundled skills, and `.codex/agents/spec-implementer.toml`.
2. **Subagent per task, verified by a script.** The orchestrator never trusts the subagent's summary. It calls
   `verify-task.cjs next` (which task, plus the context packet), dispatches the subagent, then `verify-task.cjs check`.
   That script compares `tasks.md` with the pre-state, re-runs `Done when:`, runs the project tests and `openspec validate --strict`,
   applies timeouts, reverts a bad tick, and counts attempts.
3. **Sequential fallback.** If a harness cannot spawn a subagent (subagents disabled, `agents.enabled = false` in Codex,
   or a client without the tool), the main agent performs the task itself, **one task per turn**, with the same
   `next` → work → `check` contract. It must re-read the files listed in the packet instead of relying on earlier context.
   The verifier is identical, so the guarantees about ticks, tests and validation do not depend on delegation.
4. **Guard hook in all three.** `spec-guard.cjs --format cursor|claude|codex` uses the same decision logic. Codex loads the
   project hook only after the user trusts the project. Until then the guard is advisory (the AGENTS.md rule).
5. **Duplicates in Cursor.** Cursor also reads `.claude/` and `.codex/`/`.agents/` locations. When several harnesses are installed
   into one repo, Cursor may list the bundled skills twice. Agents dedupe by name with `.cursor/` winning (documented); for
   skills the docs do not specify precedence. Install only the harnesses a team uses (`--harness`).

6. **Visual reviewer subagent.** `harness/agents/spec-visual-reviewer.md` (front matter `readonly: true`) renders to
   `.cursor/agents/spec-visual-reviewer.md` with `readonly: true`, `.claude/agents/spec-visual-reviewer.md` with
   `tools: Read, Grep, Glob`, and `.codex/agents/spec-visual-reviewer.toml` with `[features] shell_tool = false`. A Codex
   agent file cannot set its own sandbox; it inherits the parent's. Turning the shell off is the documented way to
   reduce its capabilities; `view_image` stays on, and the instructions also say "do not edit".
   The orchestrator dispatches it only after `verify-task.cjs check` exits 5. It hands the reviewer the absolute path of a
   review prompt, because Codex's `view_image` uses a path only when it is given one. The prompt lists before -> after
   pairs of clip images of the task's affected areas and their ARIA diff. `next` takes the before images and `check` the
   after images, under the run log; they are never committed. The orchestrator saves the reply and runs
   `verify-task.cjs review --reply <file>`. The reviewer never writes; the verdict
   is parsed by the script (`DEFECT:` lines, `STATUS: pass|fail|error`), so the same reply format works in all three.
   For a scenario with a design reference (`reference:`), `check` also writes a temporary side-by-side image per viewport
   (rendered area | design reference picked for that width, `<state>@<width>.vs-design.png`, never committed) and the prompt
   adds the design rubric (layout, hierarchy, spacing, colour, typography, components). The reply then needs one cited
   `RUBRIC: <scenario id> <item>: pass|fail - <citation>` line per item; `review` refuses a reply with a missing or uncited
   item, a failed item under `STATUS: pass`, or a failed item without a `DEFECT:` line (exit 2, nothing recorded), and logs
   the per-item verdicts in `metrics.jsonl`.
7. **Review is off by default and never a self-review.** `visual.review: off` is the template default: the gate is the
   screenshot-free checks (DOM geometry, `expect:` computed styles and geometry against the design map, axe, runtime, ARIA
   guard). `visual.review: subagent` adds the image review only where an independent `spec-visual-reviewer` can be dispatched:
   Claude Code and Cursor through the Task tool, Codex by spawning the agent. Without subagent support, or when the reviewer
   answers `STATUS: error`, the orchestrator runs `review <change> --reviewer none` (logged as `skipped` in `metrics.jsonl`)
   instead of judging its own screenshots; `--reviewer self` is refused. Reason: in test runs the implementer's own
   image review approved defects an outside reviewer caught and added time without moving hidden-test or fidelity scores.
8. **No pixels in the gate.** The pass/fail decision uses no image in any harness: DOM geometry and computed styles,
   axe, console/network/image events and Playwright ARIA snapshots, compared with a capture of the same scenarios taken
   just before the task. So the three harnesses get the same gate whether or not their subagents can see images; only
   the review step depends on image viewing.
9. **Quality rules live in the script, not the prompt.** These are all in `verify-task.cjs`/`quality.cjs`:
   - the size check (`Size: S|M|L` in proposal.md against the specs) and the plan caps (3/5/8 implementation tasks);
   - the trace check (`[capability/scenario-slug]` in test titles) and the source-text rule;
   - the typecheck/lint commands and the `finish` close-out.

   So Claude Code, Cursor and Codex enforce them identically. The harness renderings only say when to run `finish` and
   how to dispatch its one fix subagent. The close-out moved from agent tasks to `finish` because of the pilot runs:
   review and close-out tasks were 5 of 10 (T01) and 6 of 11 (T07) dispatches and 29%/38% of apply time, and 12 of 14
   reviews found nothing. The early review stays where it paid off: group 1 of L changes, and groups marked `(risky)`.

## Known gaps

- **Codex:** no project slash commands. Users type `$spec-apply <change>` or ask "use the spec-apply skill". The skill's
  description is written so implicit selection works too. Hooks need project trust. Subagent timeouts are not configurable
  per agent; the verifier's timeouts cover the checks, not the subagent's own run.
- **Claude Code:** `.claude/commands/` is the legacy format but fully supported. `CLAUDE.md` does not include `AGENTS.md`
  automatically, so the installer appends an `@AGENTS.md` import line to `CLAUDE.md` (managed, idempotent).
- **Cursor:** `readonly` is the only permission knob for a subagent. The implementer must write code, so it stays writable.
- **All:** each harness has a subagent-stop hook (Cursor `subagentStop`, Claude Code `SubagentStop`, Codex `SubagentStop`
  with `last_assistant_message`), but payloads and blocking semantics differ, and Codex skips untrusted project hooks.
  So verification stays the orchestrator's job by contract, not a hook. The script makes that job mechanical, and a
  rejected `check` restores `tasks.md`, so a lying subagent cannot leave a ticked box behind. What the contract cannot
  stop is an orchestrator that skips `check` entirely; wiring `verify-task.cjs check` into those hooks is a possible
  next step once it can be tested against each real harness.
- **Visual review:** only an independent reviewer subagent reviews images; a harness run without subagents gets no image
  review (`--reviewer none`) and relies on the deterministic checks. In the workspace layout the area images
  live under the specs repository's `openspec/.apply-runs/`; Codex's sandboxed `view_image` may refuse paths outside the
  code repository's writable roots, so add the specs repo as a writable root (or use the fallback).
- **Untested here:** no `agent`, `claude` or `codex` CLI and no API keys exist on the build box, so the generated
  files were checked for format (front matter, TOML parse, hook JSON) and the flow with stub subagents only. The visual
  check itself (Playwright, axe, ARIA guard, pre-task capture, worktree fallback) is tested for real; the reviewer subagent is tested with stub replies.

## Traceability layer

Everything new is in the shared Node scripts (`traceability.cjs`, driven by `verify-task.cjs`) and in the generated
command bodies, so Claude Code, Cursor and Codex get the same behaviour. `/spec-garden` is one more command rendered like the others
(`.cursor/commands/`, `.claude/commands/`, `.agents/skills/spec-garden/`). `/spec-archive` runs `/spec-sync` first and calls
`verify-task.cjs archive` in all three, and the implementer subagent writes `@spec` comments in all three. Nothing about the layer needs a hook. Gaps:
- The prompt guard only blocks `/opsx:archive` prompts. A bare `openspec archive` typed in a shell is not stopped on any harness; drift reports it later.
- The agent writes the owner-approval line after the owner agreed; the script cannot verify it.
- None of this was exercised with a real `claude`/`codex`/`agent` CLI on the build box. Stub orchestration and the measured runs used a single agent runner (see the CHANGELOG).

## Sources

- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Claude Code skills and commands (commands merged into skills): https://code.claude.com/docs/en/slash-commands
- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Cursor subagents: https://cursor.com/docs/subagents
- Cursor skills: https://cursor.com/docs/skills
- Cursor hooks: https://cursor.com/docs/hooks
- Codex subagents and custom agents: https://developers.openai.com/codex/subagents
- Codex skills and AGENTS.md: https://learn.chatgpt.com/docs/customization/overview
- Codex hooks: https://developers.openai.com/codex/hooks
- Cursor Agent tools (Read files supports image files for vision models): https://cursor.com/docs/agent/overview
- Cursor 1.7 changelog (Agent reads workspace image files): https://cursor.com/changelog/1-7
- Codex `view_image` feature flag (`features.view_image`, stable, on by default): https://github.com/openai/codex/blob/main/codex-rs/features/src/lib.rs and https://github.com/openai/codex/pull/36966
