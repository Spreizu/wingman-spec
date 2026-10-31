---
description: "New product, internal step of /spec-green-start: split the finished spec into ordered slices (walking skeleton first, risky integrations early) in roadmap/."
argument-hint: "[--replan]"
---
Turn the finished, signed-off specification into an ordered roadmap: one file per slice in `roadmap/`. You only plan; no code, no spec changes.

{{> specs-root}}

1. Run `.wingman-spec/bin/wingman-spec mode --for plan`. If it exits 6, print its text and stop. Then read `specs/`, `greenfield/capabilities/` and `greenfield/records/` (the `A-*` assumptions and `ENV-*` environments).
2. Create each slice with `.wingman-spec/bin/wingman-spec greenfield new slice <id>` and fill in the front matter and the acceptance criteria.
3. Rules for the slices:
   - The first slice is the **walking skeleton**: the thinnest path through the whole system that a person can use, with the riskiest integration (its sandbox or a stub) in it. `skeleton: true`, no dependencies, at most 5 requirements.
   - Risky integrations and unknowns come early. Every integration's first slice lists it under `contract_tests` and builds a stub plus a contract test for it.
   - Every slice names its requirements (`capabilities: [cap, cap/requirement-slug]`); every requirement belongs to a slice. `non-functional-requirements` need no slice: they apply to all.
   - Small: size S (1 capability, 3 requirements), M (2 capabilities), L (3 or more, or any risk): the verifier computes the size it needs. Split instead of declaring L when you can. Declare `depends_on` only for real dependencies, so independent slices can run in parallel; `milestone` m1, m2, ... groups what the client can use together.
   - Acceptance criteria are observable results, not tasks. Assumptions with a re-plan trigger name the slices they affect in `Notes`.
4. Run `.wingman-spec/bin/wingman-spec roadmap` and fix every error it lists. Warnings (risky integration late, overlapping coverage) need a reason in the slice `Notes` or a change of order.
5. With `--replan` (an assumption was invalidated, or the specs changed): edit only slices that are not applied; applied slices stay as they are.
