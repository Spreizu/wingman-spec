# UX completeness checklist

A UI request names the happy path ("add a task list with an add form"). The states around it (loading, empty, error,
disabled, validation, recovery, keyboard, narrow, long text) are decided by whoever writes the spec; when nobody does,
the implementer picks silently and the visual check has nothing to verify. The checklist makes each state a decision
that is written down once, at proposal time, where it becomes a scenario, a tagged test and a visual state.

## Where it lives

- Text: `project-template/harness/partials/ux-completeness.md`, one file, included by `/spec-explore`, `/spec-propose`
  and `/spec-green-start` (the partial mechanism of `scripts/render-harness.sh`).
- Answers: the `## UX checklist` section of `proposal.md`, one line per item: `- keyboard: scenario tasks/keyboard-add`
  or `- loading: Not applicable: the list is read from local state`.
- Review: the `spec-reviewer` agent and the greenfield capability review (`RUBRIC.spec`) check that every UI-facing
  requirement has its checklist answered.

## Lint

`verify-task.cjs lint` runs `uxLint` (warning level, so `ok` is unchanged). A change is UI-facing when its specs carry a
visual block or its `tasks.md` names UI files (`.vue`, `.jsx`, `.tsx`, `.svelte`, `.astro`, `.html`, `.css`, `.scss`,
`.less`) in `Files:` lines; test files do not count. Slice changes are skipped (their capability answered the checklist).
It warns when the section is missing, an item has no answer, a `scenario <id>` names a scenario the change lacks, a
`Not applicable` has fewer than three words, or an answer has neither form. A non-UI change is never checked, so a
backend change carries no placeholder.

## Why `Not applicable` is allowed

A form with no input has no validation timing, and a static list never loads. Forcing a scenario there produces noise
that is never tested. The one-line reason is reviewed by `spec-reviewer` and stays in the proposal as the record.
## Measurement (small sample, not a benchmark)

Five spec-writing runs per variant (a result grid with search, two item lists, two task lists; prompts that name no states), written by
one agent that knew the checklist while writing the baseline. The variant with the checklist was written as the baseline plus the
checklist answers, so it cannot show less by construction.

| | without | with |
|---|---|---|
| scenarios per run | 7.2 | 11.0 |
| scenarios about a state or flow (keyword count) | 2.4 | 6.2 |
| of the 9 items, covered by a scenario | 2.0 | 5.4 |
| proposal words | 188 | 286 |
| all artifact words | 649 | 947 |

- 19 `Not applicable` lines; 17 were specific to the screen, 2 were weak (a persisted list's storage failure, a layout at 375px).
  The lint only checks length; `spec-reviewer` judges the reason.
- One result-grid change went through apply with and without the checklist. Hidden acceptance tests (6/6) and mutation score (0.933)
  were equal. The added long-query scenario failed the visual check once (the page scrolled sideways at 375px) and was fixed; the
  version without it ships that defect, which no hidden test covers.
- The lint flagged all 5 runs without a checklist and none with one. Over 153 historical non-UI changes it flagged none.
  It found one interaction: the edge-word hint read the checklist's item names as plan prose; the hint now skips that section.
- Not shown: that an agent without the text would miss these states, and any effect on hidden-test scores.
