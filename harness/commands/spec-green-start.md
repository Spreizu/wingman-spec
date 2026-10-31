---
description: "New product: write its whole specification from client requirements. The only command the analyst runs; run it again and again, it continues where the project is."
argument-hint: ""
---
Write the specification of a new product (greenfield) from the client's requirements. You never choose the order: the verifier knows the phase and names the one next action. Run this command again after every pause; it is safe to run at any time.

{{> specs-root}}

## Every run

1. Run `.wingman-spec/bin/wingman-spec greenfield status`. If it exits 6 (REFUSED), print its text, say what it names instead (`/spec-adopt`, `/spec-propose`, `/spec-garden`) and stop. Nothing was written.
2. Do exactly the step it names under `Next:` and nothing else (the playbook below). Do not run `/spec-propose`, `/spec-sync` or any other command on your own initiative: this command calls them where the step says so.
3. Run status again. Repeat 2 and 3 until `Next:` says it needs a person, or the first line is `READY FOR HANDOVER`.
4. End every run with these three lines, copied from the last status output and in plain words (no file paths unless the person must open one):
   `Done:` what is finished. `Next:` the one thing to do next. `Blocked by:` who or what, or `nothing`.

When a step needs a person (the analyst, the client), stop and say exactly what to bring, then end with the three lines. Never approve, sign off or answer for them.

## Playbook (the step name is shown by status)

- **confirm-start**: ask "Is this a NEW product with no existing code, and do we write its specification from requirements?" Run the start command it prints only after a clear yes.
- **add-inputs**: tell the analyst to put the client material into `inputs/` (its README says how). Stop.
- **explore**: read everything in `inputs/` first. Then run the whole-product exploration with the interview rules of `/spec-explore`: one question at a time, with your recommended answer, never a question the inputs already answer. Write `exploration.md` and one capability file per capability or integration (`greenfield new ...`). Capture what the client wants and why in their words, never a feature: it becomes the `Why:` line of each requirement.
- **create-questions**: run the command (one `Q-<topic>.md` file per question in `greenfield/records/`; add your own with `greenfield new question <topic>`). **answer-questions**: give each question one answer:
  - an answer from the inputs, citing the file;
  - `asked` (sent to the client);
  - `assumed`, plus an assumption with owner, verification point and re-plan trigger;
  - `n/a`, with a reason.

  Answer only what a document says; never invent a number.
- **wait-for-client**: give the analyst the short list of questions for the client. Stop. **write-assumptions**, **write-environments**: fill the `A-<slug>.md` and `ENV-<name>.md` files in `records/`; secrets by name only, never a value.
- **write-understood**: write the one-page summary in plain words (the client reads it, not a developer). **approve-understood**: stop; the analyst records it with the client's name after the client agreed.
- **propose-foundation / finish-foundation**: create the change `foundation` with `Kind: spec-only` in `proposal.md`: `Owner approval:` is the client's name (approval of `understood.md`), `non-functional-requirements` with a number and a unit in every requirement, the fixed decisions as ADRs, `glossary.md`. `tasks.md` is one ticked line. No code tasks, no code.
- **propose-capability / finish-capability**: create the change named after the capability, `Kind: spec-only`: requirements, each with a `Why:` line (who wants it, and why) and WHEN/THEN scenarios a tester can run. An integration also gets a `Contract` requirement (use the integration contract template of the schema), at least 2 `Failure:` scenarios, and its sandbox. Do the capabilities in the order status shows.
- **sync-* / archive-***: run the archive command shown (`/spec-archive <change>` syncs first: specs, ADRs, then the verifier). Use `/spec-sync <change>` on its own only to inspect or fix a sync problem.
- **review-spec, review-plan, dry-run**: build the packet with the command shown, give it to the `spec-reviewer` subagent (never review your own work, never answer for it), write its reply to a file and record it with the `--reply` command shown. A different agent must do this: if no subagent is available, stop and tell the analyst.
- **fix-review-findings, fix-plan-findings, fix-roadmap, fix-gate, resolve-unknowns**: fix exactly what the list names, with a spec-only change for specs and edits of the slice files for the plan. A finding you disagree with is not skipped: say so to the analyst.
- **signoff-spec**: stop; the analyst records the client's sign-off with the command shown.
- **plan**: run `/spec-green-plan`. **write-handover**: run the command shown.
- **ready**: say `READY FOR HANDOVER`, name the manifest, and tell the analyst to send the repository to the development team (they run `/spec-green-next`).

## UI-facing capabilities

{{> ux-completeness}}

## Rules
- The spec describes the finished product, not the work: requirements, contracts, failure cases, numbers. No implementation code, no task lists in specs.
- Credentials never enter a file. Name the secret and who provides it.
- If the analyst gives new information, put it into `inputs/` as a note and run status again: the state machine reopens whatever it affects.
