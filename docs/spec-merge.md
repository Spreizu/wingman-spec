# How the archive merges delta specs

`wingman-spec archive` (and `sync`) merges each delta spec of a change into the living spec of its capability. The merge is
strict: a case with more than one reading is refused, every problem is reported at once with its file and line, and nothing
is written. Agents never edit `specs/` by hand.

## Semantics

- Sections apply in a fixed order: `## RENAMED` (`- Old -> New`), `## REMOVED`, `## MODIFIED`, `## ADDED`.
- A MODIFIED block replaces the whole requirement (SHALL text, `Why:`, scenarios); when the requirement is also renamed it
  names the new name. ADDED blocks are appended in delta order. Names compare without case and extra spaces.
- A new capability (no living spec) takes only ADDED; its `## Purpose` comes from the delta, or a placeholder.
- Idempotent: a living spec that already shows the delta's result is left byte for byte as it is, so a second run writes
  nothing. A removed or renamed-away requirement counts as merged only when the base records that it existed.
- The result is computed in memory, parsed back (same requirements, prelude and tail, or the merge is refused), and only
  then written: each file through a temporary file and a rename. With two or more capabilities the files already written are
  restored when a later one fails (best effort: the process can still be killed between two renames).

## The base

`changes/<change>/spec-base.json` records, per capability the change touches, whether the living spec existed and the hash
of each requirement the delta names, as the living spec was when the change was planned. `lint`, `validate` and `sync` pin a
capability the first time they see it; later runs never move the pin. At merge time a requirement whose living text no
longer matches its pin is refused (`base changed`): another change was archived in between. Read the new living text,
update the delta, then run `wingman-spec sync <change> --rebase`, which re-pins the current text.

## Refused cases

| Case | Example | Message |
|---|---|---|
| A name twice in one delta | two `ADDED` blocks named `New` and `new`; MODIFIED and REMOVED of one requirement | `is named twice in this delta` |
| ADDED or REMOVED of an old rename name, MODIFIED of the old name | `Greet -> Greeting` plus `MODIFIED: Greet` | `is named twice` |
| Renaming onto a name the delta adds or removes | `Greet -> Greeting` plus `ADDED: Greeting` | `renaming onto an ADDED or REMOVED name` |
| Rename chains and swaps | `A -> B`, `B -> C`; `A -> B`, `B -> A` | `rename chains, swaps ... are refused` |
| Two renames to one name | `A -> Same`, `B -> same` | `two requirements get the name` |
| A rename that changes only case or spacing | `Greet -> greet` | `is not a rename` |
| Rename onto an existing requirement, or of a missing one | `Greet -> Old pager` | `already exists`, `RENAMED: no requirement` |
| MODIFIED or REMOVED of a missing requirement | `MODIFIED: Nope` | `no requirement "Nope"` |
| ADDED of an existing requirement | `ADDED: Greet` | `already exists (a change to it goes under ## MODIFIED)` |
| A scenario name twice in one requirement | `One` and `one` | `repeats the one on line` |
| `## Purpose` for a capability that has a living spec | | `## Purpose is only for a new capability` |
| MODIFIED, REMOVED or RENAMED for a new capability | | `only ## ADDED is allowed` |
| A legacy heading | `## ADDED Requirements` | ``write `## ADDED` `` |
| A living spec with one requirement twice | | `is in the living spec twice: fix the living spec first` |
| The living text changed since the pin | another change modified `Greet` | `base changed` |
| The capability was created or deleted since the pin | | `created this capability` / `was deleted` |
| No pin for a named requirement | | `no base recorded` |
| The result does not parse back to what was merged | | `reads back differently` |

`internal/spec/merge_test.go` tests every row. Its property test merges random deltas into random living specs: the
merge is idempotent, keeps every untouched requirement byte for byte and in order, and parses back. A second property
test injects each refused kind into a random delta and expects the refusal.
