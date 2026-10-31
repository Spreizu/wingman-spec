# UX completeness checklist

A UI request names the happy path ("add a task list with an add form"). The states around it (loading, empty, error,
disabled, validation, recovery, keyboard, narrow, long text) are decided by whoever writes the spec; when nobody does,
the implementer picks silently and the visual check has nothing to verify. The checklist makes each state a decision
that is written down once, at proposal time, where it becomes a scenario, a tagged test and a visual state.

## Where it lives

- Text: `harness/partials/ux-completeness.md`, one file, included by `/spec-explore`, `/spec-propose`
  and `/spec-green-start` (a `{{> ux-completeness}}` partial, rendered by `wingman-spec init` and `update`).
- Answers: the `## UX checklist` section of `proposal.md`, one line per item: `- keyboard: scenario tasks/keyboard-add`
  or `- loading: Not applicable: the list is read from local state`.
- Review: the `spec-reviewer` agent and the greenfield capability review (`RUBRIC.spec`) check that every UI-facing
  requirement has its checklist answered.

## Lint

`wingman-spec lint` runs `uxLint` (warning level, so `ok` is unchanged). A change is UI-facing when its specs carry a
visual block or its `tasks.md` names UI files (`.vue`, `.jsx`, `.tsx`, `.svelte`, `.astro`, `.html`, `.css`, `.scss`,
`.less`) in `Files:` lines; test files do not count. Slice changes are skipped (their capability answered the checklist).
It warns when the section is missing, an item has no answer, a `scenario <id>` names a scenario the change lacks, a
`Not applicable` has fewer than three words, or an answer has neither form. A non-UI change is never checked, so a
backend change carries no placeholder.

## Why `Not applicable` is allowed

A form with no input has no validation timing, and a static list never loads. Forcing a scenario there produces noise
that is never tested. The one-line reason is reviewed by `spec-reviewer` and stays in the proposal as the record.
