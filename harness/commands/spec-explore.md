---
description: "Explore an idea or problem with the grilling skill before planning a wingman-spec change."
argument-hint: "[topic]"
---
Explore an idea, requirement or problem before planning it, with the `grilling` skill driving the conversation.

{{> specs-root}}

**Input**: optional topic or change name after `/spec-explore`. If a change name is given (check `.wingman-spec/bin/wingman-spec list`), read its existing artifacts for context.

This is a thinking mode. Do NOT write application code and do NOT create change artifacts here; that is `/spec-propose`.

**Slug.** Use a kebab-case slug for the topic (the topic after `/spec-explore`, or ask for one). It names the design map (`explore-design/<slug>.md` in the specs root) and the change `/spec-propose <slug>` creates.

**Steps**

1. **Load context.** Read the project context (`.wingman-spec/bin/wingman-spec config`, its `context:`), skim `specs/` for existing capabilities, and, if exploring an existing change, its artifacts. If the project has no app-map yet (no earlier change contains one), note that the first planning pass should map the whole app.

2. **Grill.** Invoke the `grilling` skill by name and work it with the user:
   - Build the design tree; ask each round's whole frontier of open decisions, each with your recommended answer.
   - Answer from the repo first: before each question, look for the answer in the code, specs, docs, config and git log, and state what you found (file, line) instead of asking. Ask only what the repo cannot answer: a decision, a priority, an external fact.
   - Cover, as relevant: product goal and users, capability boundaries, build order (thin vertical slices), data and integration constraints, cross-cutting concerns, which decisions deserve an ADR, and what "done" means for junior developers to test.
   - *Fallback if the skill is unavailable*: interview in numbered rounds with a recommended answer per question, until no decision is left assumed.

2b. **Design input.** If the request comes with a design to match, build the design map now, before any proposal:

{{> design-map}}

2c. **UX checklist** (UI-facing topics only): settle each item from the code and the request; ask only the items they leave open.

{{> ux-completeness}}

3. **Visualize and compare** where it helps (diagrams, option tables).

4. **Close the session.** When the frontier is empty, summarize:
   - Decisions settled (these feed the proposal, design and ADRs)
   - Capabilities identified (kebab-case) and a proposed first slice
   - With a design input: the design map path, how many regions map to tokens / components / framework / arbitrary, and the open Gaps
   - Anything deliberately deferred
   Then offer: "Ready to plan? Run `/spec-propose <slug>`." That propose uses **this slug only**. Do not start planning without the user's confirmation.

**Guardrails**
- Never guess product or architecture decisions; ask.
- No code, no planning artifacts. The design map (`explore-design/<slug>.md`) is the exception.
