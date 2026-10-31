---
description: "Create a wingman-spec change and write every planning artifact (app-map, proposal, specs, design, ADRs, tasks)."
argument-hint: "<change> [request]"
---
Create a change and produce every planning artifact for it, as a senior analyst writing for junior developers. The artifacts and their order come from the CLI (app-map → proposal → specs → design → adrs → tasks).

{{> specs-root}}

**Input**: a change name (kebab-case) or a description of what to build after `/spec-propose`. If it is a description, derive a kebab-case name and confirm it. If nothing is given, ask what to build.

Confirm the kebab-case change name first; that name is also the exploration slug.

**Steps**

0. **Check the project config.** Run `.wingman-spec/bin/wingman-spec doctor`. If `commands.test` or the `visual:` `command` or `url` is still `<fill in>`:
   - Ask the user for the values. Suggest what the repository's scripts show, for example `npm test` or `npm run build && npm run preview -- --port 4173 --strictPort`.
   - Write them into the file doctor names, under `commands:` and `visual:`. With a linked specs repository that is this code repository's own `.wingman-spec/wingman-spec.yaml`, not the specs repository's file.
   - Do this before planning: `/spec-apply` refuses to start while they are placeholders.
   Show doctor's `warnings` to the user, for example "Playwright not installed, so the visual check would be skipped".

1. **Check readiness.** If product or architecture decisions are still open, run the `grilling` skill with the user first. Do not guess answers.

2. **Create the change.** Run `.wingman-spec/bin/wingman-spec new <name>`, then `.wingman-spec/bin/wingman-spec status <name>` to see the artifacts (`app-map, proposal, specs, design, adrs, tasks`).
   Then record the start in the timeline: `.wingman-spec/bin/wingman-spec log <name> start "<the request, one line>"`, and `log <name> grill "<questions asked and the answers, one line>"` (or `explore`) for what step 1 settled. The CLI records each artifact it sees written or rewritten, and every `validate`, `lint` and `size` run.

2b. **Design map.** If `explore-design/<name>.md` exists in the specs root, move it to `changes/<name>/design-map.md`. If the request includes a design (image, prototype, export) and there is no map yet, build it now, before the app-map:

{{> design-map}}


3. **Write the artifacts.** Order: proposal, specs, then (full path) app-map, design, adrs, then tasks. For each artifact:
   - Run `.wingman-spec/bin/wingman-spec instructions <artifact-id> <name>` and read the dependency files it lists.
   - Create the file from its template and instruction. Treat the project context as a constraint; never copy it into the file.
   - Write the prose by the `spec-writing` skill.
   `wingman-spec lint <name>` reports the planning path and any missing artifact (`path-artifacts`). The **fast** path (Size S, `Risk: none`, no UI, no sensitive path in `Files:`) writes only proposal, specs and tasks. Every other change is **full**.

   **Decide the size before the first artifact.** The size table is in the proposal instruction; proposal.md gets `Size: S|M|L` and `Risk:` lines, and `wingman-spec size` checks them against the specs. In short: **S** is 1 capability, at most 3 requirements, nothing BREAKING, no risk, no ADR, no visual scenarios. **M** is up to 2 capabilities, or a UI change with visual scenarios. **L** is 3 or more capabilities, anything BREAKING, or a risk (security, money, data-migration, concurrency, public-api). Task caps S/M/L: 3/5/8. Size trims documents, never scenarios or edge cases.

   What each one must achieve (details are in each instruction):
   - `app-map`: where this change sits in the whole app; capabilities, dependencies, build order; this change's slice (S: `wingman-spec app-map <name> --apply`).
   - `proposal`: `Size:` and `Risk:` lines, why, what, capabilities, ADR candidates, and **Edge cases**. List every edge case the request or the user's answers name, one bullet each, ending with `-> <capability>/<scenario-slug>`. A UI case points at a visual scenario with a `state:` that shows that content.
   - `specs`: one spec per capability, with concrete, testable scenarios.
     - Each requirement has a `Why: <who wants it, and why>` line under its SHALL sentence (unless `traceability: off`). Rewriting an existing Why or removing a requirement needs the owner's approval first.
     - A requirement that computes, transforms, sorts or stores data also gets an `Invariant: ...` scenario.
     - **UI changes**: every screen, component or state the change adds or alters gets a scenario with a ```` ```visual ```` block. The block lists the route, key elements as selectors, states with the steps to reach them, viewports, and the design reference if the user gave one.
     - **From a design**: the visual block names the design images (`reference: design/x-1280.png @1280`, `reference: design/x-375.png @375`). Its `key:` lines use the map's selectors; every one needs a map row. The map's Expect column becomes `expect:` lines, at least one per map row. Every text element gets `font-size`, `font-weight` and `line-height`. Use a token where the project has one, else the literal design value: `expect: [data-testid="plan-amount"] font-size ~ token:text-display`, `expect: [data-testid="plan-name"] line-height ~ 28px`, `expect: [data-testid="save"] above [data-testid="cancel"] @375`.
     - Decide stable selectors (`data-testid`) here so the implementer and the check agree. Give each block `component:`, the file basename that renders it.
     - Only screens that a visual scenario declares are guarded. If an existing screen next to the change has none in `specs/`, say so and suggest adding one, via `/spec-adopt` or this change's specs. No screenshots are committed: the check compares each declared scenario with its own capture from just before each task.
   - `design`: decisions and a junior-oriented implementation guide (S: guide and pitfalls only; fast path: none). The design never deletes a scenario or a visual block. A visual state the live app lacks data for gets a test role, seed or route in the design, or `Not visual: <reason>; covered by <test>` under the scenario.
   - `adrs`: one `adrs/<slug>.md` per significant decision, or `adrs/none.md`. Size S writes only `adrs/none.md`; the fast path writes none.
   - `tasks`: test-first tasks with Spec / Test first / Files / Done when, and no `Size:` line (proposal.md has it).
     - Size M/L, a Risk kind or a UI change: end with one code review task. It may fix findings in any file the change's tasks name in `Files:`.
     - A task that builds UI has `Visual: <scenario ids>`. Name each visual scenario from the task after which all its key elements exist, not from an earlier shell task.
     - With a design map, `Files:` follows it: the components and token files it names, and a new component only where the map lists a gap.

3b. **UX checklist** (UI-facing changes only):

{{> ux-completeness}}

4. **Ask only when it matters.** If a question would change the specs, the approach or the task breakdown, look for the answer in the repo first. Ask the user (use `grilling`) only when the repo cannot answer it. Decide wording choices yourself. Record each answer: `wingman-spec log <name> grill "<question> -> <answer>"`. Record an owner approval the same way: `log <name> approval "<what was approved>"`.

5. **Validate.** Run `.wingman-spec/bin/wingman-spec validate <name>` and `.wingman-spec/bin/wingman-spec lint <name>`. Fix every error; each one names its rule and line. Errors include a Size line below what the specs need (raise the size and write the full artifacts) and a plan over its task cap (3/5/8). Fix warnings by merging or deleting tasks where they say so. `wingman-spec help reference` lists the checks.

6. **Summarize.** Print: change name, location, artifacts created, the ADR slugs, task count, and the next step: "Run `/spec-apply <name>` to implement, test-first."

**Guardrails**
- Follow each artifact's instruction; on the full path do not skip `app-map`, `design` or `adrs`.
- Never write ADRs to the specs root's `adrs/` here; `/spec-archive` promotes them.
- Do not start implementing. Planning only.
- If a change with this name exists, ask whether to continue it or pick another name.
