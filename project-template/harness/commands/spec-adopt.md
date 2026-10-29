---
description: "Bring an existing codebase under wingman-spec OpenSpec control: baseline specs and ADRs."
argument-hint: "[scope]"
---
Bring an existing (brownfield) codebase under spec control: derive baseline specs of what the system does today, and record the architectural decisions already in the code as ADRs. Run it once when adopting the `wingman-spec` schema in a project that already has code; later changes then use `/spec-propose` as usual.

{{> openspec-root}}

**Input**: optional scope after `/spec-adopt` (a directory, module or area, e.g. `/spec-adopt src/billing`), plus an optional flag:
- `--check`: report only, write nothing. List which capabilities and decisions are missing from `openspec/specs/` and `adr/`, which existing specs look out of date with the code, and how many entries in `openspec/observed/` still wait for an owner.

If no scope is given, cover the whole repository, but do it in slices: finish and confirm one area before the next.

This command records **current behavior as evidence, not as intent**. Existing code shows what happens today, not that anyone wants it. Only behavior that something other than the code confirms (a test, a document, the owner) becomes a requirement; everything else is written down as *observed, unconfirmed* and waits for its owner. It is not a change: it writes directly to `openspec/specs/`, `openspec/observed/` and `adr/`, and never creates an `openspec/changes/` entry. New or altered behavior goes through `/spec-propose`.

## Steps

0. **Guard.** Run `node openspec/scripts/verify-task.cjs mode --for adopt`. If it exits 6 (an in-progress new-product spec, which has no code to document yet) print its text and stop: nothing is written; use `/spec-green-start` instead.

1. **Check readiness.** Resolve the OpenSpec root, then confirm its `openspec/config.yaml` exists with `schema: wingman-spec` (otherwise tell the user to run the installer and stop; in workspace mode that config lives in the store). Read its `context` (stack, test command) and list `openspec/specs/` and `adr/` so you know what is already recorded.

2. **Survey the code (read only).** Find, in this order: documentation and README files, entry points (routes, CLI commands, jobs, event handlers), the data model, the existing tests, then configuration and dependency manifests. Tests and documents are the evidence of intended behavior; code shows actual behavior. Never run destructive commands. Running the existing test suite is allowed and useful.

   **Classify every behavior you find** before you name capabilities. It is *confirmed* only when a test asserts the rule, a document states it, or the owner says so, and these do not contradict the code or each other. Everything else is *unconfirmed*; it is never written as a requirement. Unconfirmed kinds:
   - `contradicts-doc`: the code differs from the README, a comment or a test title (boundaries such as `>` against "or more", rounding, limits).
   - `suspected-bug`: swallowed errors (empty `catch`, ignored return value), `TODO`/`FIXME`, dead branches, an action that answers success but changes nothing.
   - `debug-leftover`: debug, dump, test or admin routes, flags and logging that no document or test mentions.
   - `incidental`: starting ids, header values, exact error texts, ordering, timings, that nothing documents or tests.
   - `unclear`: you cannot tell what is wanted.
   - `untested`: the code does it, but no test or document says so.

3. **Propose the capability inventory.** Group behavior into capabilities named in kebab-case, one per cohesive user-visible behavior (not per file or layer). For each: one line of purpose, the code locations that implement it, and how well it is covered by tests (none, partial, good). Present this table, the list of candidate decisions (framework, data store, auth approach, API style, sync vs async, deployment shape) and the unconfirmed list (one line each) to the user. Use the `grilling` skill to settle names, boundaries and which capabilities are in scope now. Ask the owner, in the same round, about each unconfirmed item: *intended* (it becomes a requirement with `Confirmed: owner <name>, <date>`), *bug* or *not wanted* (it stays in the observed file; fix it later with `/spec-fix`), or no answer (stays open). Do not write anything until the user confirms. *Fallback if the skill is unavailable*: ask in numbered rounds with a recommended answer for each.

4. **Write baseline specs and the observed list.** For each confirmed capability that has no `openspec/specs/<capability>/spec.md`, create it. Rules:
   - Format for a main spec: `## Purpose` (one or two sentences, 50+ characters, then a last line `Baseline: adopted <today, YYYY-MM-DD>`), then `## Requirements` with `### Requirement: <name>` and a SHALL/MUST statement. Do **not** use delta headers (`## ADDED Requirements`); those are only for changes.
   - Under the SHALL statement of every requirement write one line `Confirmed: test <file>: <test name>`, `Confirmed: doc <file>` or `Confirmed: owner <name>, <date>`. No such evidence, no requirement; `verify-task.cjs drift` lists adopted requirements without it.
   - Each requirement has at least one `#### Scenario: <name>` (exactly 4 hashtags) with WHEN/THEN bullets, concrete inputs and exact outputs taken from the confirming test or document.
   - Describe observable behavior only. No function, class or library names, and no how-it-works.
   - When a document and the code disagree, the requirement covers only the part on which document, test and code agree, with the exact range ("more than 100.00 EUR", not "large"). The disputed part goes to the observed list. Never write the code's version of the disputed part, and never hide a dispute behind a vague word.
   - If you cannot determine behavior from code, tests or docs, do not invent it. Put it on the observed list.
   - **Never overwrite or edit an existing spec.** If `openspec/specs/<capability>/` exists, skip it and report "exists". If it has drifted from the code, say so in the summary and recommend `/spec-fix` for a small correction, or `/spec-explore` then `/spec-propose` for new work.

   Write every unconfirmed item to `openspec/observed/<capability>.md` (one file per capability, created even when the capability has no spec yet; no index, so parallel branches never touch the same lines). Leave an existing entry as it is (match by slug) and add only new ones:
   ```
   # Observed, unconfirmed: <capability>

   Code is evidence of what happens today, not proof it is wanted. Nothing here is a requirement.

   ## <entry-slug>
   - Observed: <what the code does, with file:line>
   - Why unconfirmed: <contradicts-doc | suspected-bug | debug-leftover | incidental | unclear | untested>, <one sentence>
   - Owner: <the person or role who can decide>
   - To confirm: <the exact question to ask or check to run>
   ```
   Once the owner decides: intended means a requirement through `/spec-propose` (or `/spec-fix`) and the entry is deleted; a bug means `/spec-fix` and the entry is deleted; not wanted means the entry is deleted with the code change.

5. **Record ADRs for decisions already in the code.** For each confirmed decision, write `adr/NNNN-<slug>.md` following the promotion rules of `/spec-sync` step 2, with these front matter values:
   ```
   ---
   title: <title>
   status: Accepted
   date: <today, YYYY-MM-DD>
   change: baseline
   source: baseline/<slug>
   ---
   ```
   Body per `schemas/wingman-spec/templates/adr.md` (Context, Decision, Alternatives considered, Consequences). Be honest about what is unknown: state in Context that the decision was recorded retroactively from the code on this date, and write "unknown" rather than inventing alternatives or history. Number: highest existing `NNNN` plus 1. If a file whose front matter has `source: baseline/<slug>` already exists, update it in place and keep its number and file name. Make sure `adr/README.md` exists as `/spec-sync` step 6 describes (static, no table). Skip this step if the user declined ADRs, and when the project has no significant decision to record say so.

6. **Validate.** Run `openspec validate --specs --strict`, then `node openspec/scripts/verify-task.cjs drift --text` and fix every `unconfirmed-requirement` and `observed-incomplete` entry of the files you wrote. Do not touch other specs.

7. **Summarize.**
   ```
   ## Adopted: <scope>
   Specs:
   - <capability>: written (<n> requirements, <m> scenarios) | exists, skipped | drifted (recommend /spec-fix)
   ADRs:
   - <slug>: written as adr/0001-<slug>.md | updated | unchanged
   Observed, unconfirmed (openspec/observed/<capability>.md):
   - <capability>: <n> open (<kind>: <entry-slug>, ...)
   Test coverage gaps:
   - <capability>: no tests | partial
   Next: run /spec-explore to plan the first change, or start the next area with /spec-adopt <scope>.
   ```

## Guardrails
- Read-only on application code: this command writes only under `openspec/specs/`, `openspec/observed/` and `adr/`.
- Never create or modify anything in `openspec/changes/`, and never archive.
- Never overwrite an existing spec. Re-running must change nothing that is already recorded.
- Do not guess product intent. When code and docs disagree, or behavior is unclear, ask the owner and keep it on the observed list; never choose for them.
- A suspected bug, a debug leftover or an incidental detail is never a requirement, whatever the code does today.
- Keep each run to a scope the user can review in one sitting; large repositories are adopted area by area.
