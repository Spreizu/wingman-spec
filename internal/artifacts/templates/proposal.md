Size: M <!-- S, M or L, from the size table in the proposal instruction. S: 1 capability, at most 3 requirements, nothing BREAKING, Risk: none, no ADR, no visual scenario. M: up to 2 capabilities, or UI with visual scenarios. L: 3 or more capabilities, BREAKING or any risk. Caps 3 / 5 / 8 implementation tasks. `wingman-spec size` checks it. -->
Risk: none <!-- or the kinds that apply: security, money, data-migration, concurrency, public-api. Any risk makes it L. -->

## Why

<!-- 1-2 sentences: the problem or opportunity, and why now. Each requirement has its own `Why:` line in the delta specs.
     To rewrite an existing Why or remove a requirement, ask the owner. After they agree, add `Owner approval: <name>, <date>` here. -->

## What Changes

<!-- Bullets. Mark breaking changes with **BREAKING**. -->

## Capabilities

### New Capabilities
<!-- kebab-case names from the app-map "This change" section. Each creates specs/<name>.md -->
- `<name>`: <brief description>

### Modified Capabilities
<!-- Existing capabilities (the living specs/) whose REQUIREMENTS change. Leave empty if none.
     A change with no capabilities adds the line `Specs: none` under Risk:. -->
- `<existing-name>`: <what requirement is changing>

## ADR candidates

<!-- Architecturally significant decisions this change forces. One line each, with a proposed slug.
     Write "none" if there are none. -->
- `<slug>`: <decision to be made>

## Impact

<!-- Affected code, APIs, dependencies, systems. -->

## Edge cases

<!-- One bullet per edge case the request or the user's answers name: long text, empty, error, many items, limits,
     invalid input. End each with the scenario that proves it. A UI case points at a visual scenario whose state
     shows the content. Write "- none named" only if there are none. Size never removes one. -->
- <edge case in the user's words> -> <capability>/<scenario-slug>

## UX checklist

<!-- UI changes only (a screen, form, control or visual scenario); delete this section otherwise. One line per item:
     `- <item>: scenario <capability>/<slug>` or `- <item>: Not applicable: <reason specific to this screen>`.
     Items: loading, empty, error, disabled, validation, recovery, keyboard, narrow, long-text. `wingman-spec lint` warns about a missing or unanswered item. -->
