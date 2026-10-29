**UX completeness (any UI-facing capability or requirement: a screen, form, control or visual scenario).** `/spec-explore` settles each item with the user; `/spec-propose` writes `## UX checklist` in `proposal.md`, one line per item: `- <item>: scenario <capability>/<slug>` (a WHEN/THEN scenario, plus a visual block for a look or state) or `- <item>: Not applicable: <reason>` (specific to this screen).
- `loading`: what shows while data loads or a save is pending
- `empty`: no items, no results
- `error`: a load or save fails
- `disabled`: when a control is disabled, and how it looks
- `validation`: when an input error appears (typing, leaving the field, submit) and how it clears
- `recovery`: what the user can do next after an error
- `keyboard`: every action reachable and operable by keyboard, visible focus, focus order
- `narrow`: the layout at 375px
- `long-text`: very long text, many items

`verify-task.cjs lint` warns about a missing or unanswered item.
