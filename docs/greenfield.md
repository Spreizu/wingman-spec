# New product: plan from requirements

For a product with no code yet. The analyst runs one command, `/spec-green-start`, again and again. It asks the verifier
(`wingman-spec greenfield status`) for the phase and the one next action, does it, and ends every run with
`Done`, `Next` and `Blocked by`. Developers later run `/spec-green-next`.

| Phase | What ends it |
|---|---|
| Inputs | the client's material is in `inputs/` |
| Questions | every question answered from a document, asked, or assumed (with owner, check point and re-plan trigger) |
| Foundation | `understood.md` approved with the client's name; numeric non-functional requirements, fixed decisions as ADRs |
| Capabilities | one spec-only change per capability and integration (requirements with their Why, contracts, failure cases) |
| Review | a different agent reviews the spec; the client signs it off |
| Roadmap | `/spec-green-plan` writes `roadmap/<slice>.md`: walking skeleton first, risky integrations early, size caps S/M/L |
| Handover | `wingman-spec handover --write` when the gate is green |

The spec is the end state of the product. A slice carries tasks only (`Slice: <id>`, no spec delta); later changes go through
`/spec-propose` and `/spec-garden`, and rewriting a requirement's Why or removing a requirement needs the owner's approval.

**Mode guard.** `wingman-spec mode` says `greenfield`, `brownfield`, `greenfield-in-progress` or `implementation`. The marker
`greenfield.yaml` in the specs root is written only after an explicit yes. A greenfield command in the wrong mode exits 6 and writes nothing;
`/spec-adopt` refuses on an in-progress new product.

**Files and parallel PRs.** Status, order and coverage are derived from the files each time, with no committed index. Every addition is
its own file: capabilities, slices and reviews in their folders, and the analyst's questions, assumptions and environments in
`greenfield/records/` as `Q-<topic>.md`, `A-<slug>.md` and `ENV-<name>.md`. There is no per-change home for them (the first change
exists only after the roadmap), so one flat folder with typed prefixes keeps `greenfield/` small. The contributor picks the name, so two
branches that each add records add different paths and merge cleanly; the same name on both is an ordinary add/add conflict on that one
file. The shared `exploration.md` holds only the capability map and the integration inventory.

## What was tested

- `tests/greenfield.sh` (92 cases): the guard (nothing written on a refusal), the state machine, roadmap and handover checks, and a
  scripted walker that follows only `greenfield status` to `READY FOR HANDOVER`. The walker uses canned content, so it proves the state
  machine, not the quality of an agent's specs.
- One sample run (ToolShed, 4 input files): 9 capabilities, 46 requirements, 8 slices; the first two slices were built test-first (26
  tests). 2 wrong turns, 0 refusals, 4 verifier defects found and fixed, 20 of 20 hidden facts present in the specs. One agent wrote the
  inputs, the hidden facts, the specs and the code, and reviews were waived or self-done, so there was no independent review and no
  blind no-roadmap arm; the comparison with "no roadmap" is the static order only (without it PayRail, webhook and sign-in come after
  listings and inventory).

## Risks

- A large spec makes merges and `drift` slow; split by capability and keep requirements short.
- An up-front plan drifts from the code. Slices are re-checked by `roadmap` and `/spec-green-next`, but nothing forces a re-plan.
- Detail the documents lack (a webhook body format, a first administrator, age rules) is found late. Open questions are listed in the
  handover manifest; assumptions carry an owner and a re-plan trigger.
