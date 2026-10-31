<!-- Size S (see the proposal instruction): replace this whole file with two lines, "This change: ..." and "Fits: ...". -->
## Product goal and users

<!-- One paragraph: what the app is for and who uses it. List personas/roles. -->

## Capability inventory

<!-- Every capability the full app needs. kebab-case, one line each, with priority. -->
| Capability | Purpose | Priority |
|------------|---------|----------|
| `<name>` | <one line> | P0 |

## Dependencies

<!-- Which capability needs which. Keep acyclic. e.g. `billing` -> `accounts`, `auth` -->

## Bounded contexts / modules

<!-- Where the seams are and who owns what. -->

## Build order

<!-- Thin vertical slices, each shippable and testable. Slice 1 = walking skeleton. -->
1. **Slice 1 – <name>**: <capabilities> — <what a user can do afterwards>
2. **Slice 2 – <name>**: ...

## This change

<!-- Exactly which slice and capabilities this change covers; what is deferred. -->
- **Covers**: slice <n> — `<capability>`, ...
- **Deferred**: ...

## Cross-cutting concerns

<!-- Auth, error handling, logging, config, observability, i18n, ... -->

## Design map

<!-- Only when the input includes a design to match. Link to design-map.md in this change (see /spec-explore)
     and summarise its gaps; otherwise delete this section. -->

## Open questions

<!-- Only questions that can safely wait. Resolve the rest with the user first. -->
