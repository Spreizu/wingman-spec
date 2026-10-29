---
description: "Development team: build the next slice of a handed-over greenfield spec (propose and apply the slice change, then show the remaining drift)."
argument-hint: "[slice id]"
---
Build the next unblocked slice of the roadmap. The specs are the finished product; a slice is only the order of work, so a slice change carries tasks and no spec changes.

{{> openspec-root}}

1. Run `node openspec/scripts/verify-task.cjs mode --for next`. If it exits 6, print its text and stop. Then run `node openspec/scripts/verify-task.cjs handover`: unless its first line is `READY FOR HANDOVER`, or the project is already in the implementation phase, stop and show what is missing.
2. Pick the slice: the id given, else the first line of `node openspec/scripts/verify-task.cjs roadmap --next`. If none is ready, say whether everything is done or what each open slice waits for, show `node openspec/scripts/verify-task.cjs drift`, and stop.
3. Create the change `slice-<id>` with `/spec-propose slice-<id>`, as a slice change: `skip_specs: true` in `.openspec.yaml`, no `specs/` folder, `Slice: <id>` and the slice's `Size:` in `proposal.md`, and tasks that each cite the requirement or scenario they build (`Spec: <capability>/<requirement-slug>`). Read the slice file's acceptance criteria and `Notes`, the specs it covers, the `ENV-*.md` files in `openspec/greenfield/records/` and the ADRs.
4. If the slice is the first to touch an integration (`contract_tests`), its tasks build a contract test and a stub of the external system. The stub answers the contract's sandbox examples and failure cases. Later slices use the stub; only the contract test calls the real sandbox.
5. Apply it with `/spec-apply slice-<id>`, anchoring code and tests with `@spec <capability>/<requirement-slug>` markers as always. When every task is done set `status: done` in the slice file and archive the change (`/spec-archive slice-<id>`). Commit the slice file's status line with the slice.
6. End with `Done:` the slice, `Next:` the next ready slice from `roadmap --next` (or `/spec-garden` when none is left), `Blocked by:` what it waits for or `nothing`. Show the remaining drift count.

If the code shows that a spec is wrong or incomplete, do not change specs inside a slice: stop and say so, then amend through `/spec-propose` (rewriting a requirement's Why or removing a requirement needs the owner's approval).
