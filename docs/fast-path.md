# Fast path and full path

A small, low-risk change should cost a proposal, its specs and a short task list. Everything else keeps the full set of planning artifacts.

## The rule

A change is **fast** when all of these hold; otherwise it is **full**:

- `Size: S` and `Risk: none` (both lines present);
- no sensitive path in any `Files:` line (auth, session, token, password, payment, billing, migration, schema, permission, secret, crypto, and similar);
- no UI change (no `visual` blocks, no UI files in `Files:`);
- no dependency manifest in `Files:` (`package.json`, lockfiles, `composer.json`, `requirements.txt`, ...).

`wingman-spec size <change>` prints the path and the reasons. The extension shows the app-map, design and ADR steps of a fast change as skipped.

## What the fast path drops

| Artifact | Fast | Full |
| --- | --- | --- |
| `app-map.md` | none, or the two lines from `wingman-spec app-map <change> --apply` | the analyst's map (Size S: two lines, also generated) |
| `design.md` | none | guide and pitfalls (S), full design (M/L) |
| `adrs/` | none | `none.md` or the ADRs |
| final review task | none | Size M/L, a Risk kind, or UI |
| `progress.md` | none | none (the task prompt lists the earlier tasks) |

Specs, scenarios, edge cases, the `Done when:` tests, the scenario tags, the source-text rule, `finish`, drift and the owner approval are the same on both paths.

## Scope upgrade

The plan can lie about its scope, so the verifier looks at the edits. At `check` and `finish` it upgrades a fast change when the work since the run base touched a sensitive path, a UI file or a dependency manifest, or changed more than 150 lines. The upgrade is stored in `runs/<change>/upgrade.json`; the task that triggered it still passes (with a warning), and `next` then refuses with `path-artifacts` until app-map, design and the ADR record exist. The change never goes back to fast.

## Why

The planning artifacts of a Size S change cost wall time and words, and they carry no decision: one capability, no risk, no sensitive path, no UI. The gates that catch defects (the `Done when:` tests, scenario tags, `finish`) do not depend on them. The artifacts that carry a decision (design, ADRs, the app-map of a bigger change) stay mandatory for anything with a decision in it: bigger than S, any risk, sensitive paths, UI. The upgrade rule keeps the fast path honest when the plan understated the work.

The task tick moved to the verifier for the same reason: the verifier already knows the task passed, so the implementer writes no bookkeeping.
