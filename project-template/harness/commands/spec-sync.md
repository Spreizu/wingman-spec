---
description: "Sync a wingman-spec OpenSpec change: merge delta specs, promote ADRs, check anchors and drift."
argument-hint: "<change> [--check|--adrs-only]"
---
Sync a change in three steps: merge its delta specs into `openspec/specs/`, promote its ADRs to the repository-root ADR directory, then let the verifier check anchors and drift. `/spec-archive` runs it first, so run it on its own only to inspect (`--check`) or fix a sync problem.

{{> openspec-root}}

Steps 1 and 2 are **agent-driven** and step 3 is script-driven; all are **idempotent**: re-running changes nothing that is already synced.

**Input**: a change name after `/spec-sync` (e.g. `/spec-sync add-auth`), plus optional flags:
- `--adrs-only`: skip step 1 (use after a plain `/opsx:sync`, or when the specs are already merged).
- `--check`: report only, write nothing. Say what step 1 would change and which ADRs are `OUT OF DATE` or `NOT PROMOTED`, then run `node openspec/scripts/verify-task.cjs sync-check <change>` (read-only) and state clearly whether the change is fully synced. Archiving is refused unless it is.

If the name is omitted, infer it from the conversation; if ambiguous, run `openspec list --json` and ask. Always announce: "Using change: <name>".

## Step 1: sync delta specs

Follow the `openspec-sync-specs` skill (the same workflow as `/opsx:sync`) for this change, inline, and wait for it to finish. Report which capabilities were updated. Skip this step with `--adrs-only`. **Before merging**, run `node openspec/scripts/verify-task.cjs lint <change>`: once the delta is merged the old Why is gone and a rewritten Why or a removed requirement can no longer be told apart. If it lists `why_owner_approval` and the proposal has no `Owner approval:` line, stop and ask the owner; never write that line yourself. The `Why:` lines are merged verbatim with the requirement blocks (do not drop them). If the change has no delta specs, say so and continue to step 2.

## Step 2: promote ADRs

**Locations**
- Source: `openspec/changes/<change>/adrs/*.md`
- Target: `adr/` at the OpenSpec root, next to `openspec/` (the repository root, or the store in workspace mode; use another directory only if the user names one). Files are named `NNNN-<slug>.md`, where `<slug>` is the source file name without `.md` and `NNNN` is a zero-padded 4-digit number. Create the directory if needed.

**Procedure**

1. **Collect sources.** List the change's `adrs/*.md`. If the directory is missing or empty, say there is nothing to promote and stop.

2. **For each source file**, parse its YAML front matter (`title`, `status`, `date`, `change`, optional `supersedes`):
   - `status: none` (any case): skip it. It only records that the change has no significant decisions.
   - A `title` or `date` that is empty or still a template placeholder (starts with `<!--`): stop and report the file. Never promote an unfilled template.
   - A `supersedes` that is empty or a placeholder: treat as absent.

3. **Find the existing promoted ADR**: the file in `adr/` whose front matter contains exactly `source: <change>/<slug>`. This key is the ADR's identity, which is what makes the step idempotent.
   - Found: update it in place, keeping its number and file name.
   - Not found: assign the next number (highest existing `NNNN-*.md` plus 1, starting at `0001`) and create `adr/NNNN-<slug>.md`. Two parallel branches can take the same number: `verify-task.cjs sync` reports it after the merge, and `verify-task.cjs adrs --fix` renumbers the later file.

4. **Write the promoted file** with exactly this front matter, then the source body (everything after the source's front matter) unchanged:
   ```
   ---
   title: <title>
   status: <status>
   date: <date>
   change: <change>
   source: <change>/<slug>
   supersedes: <NNNN>        # only if the source has a real supersedes value
   ---
   ```
   `<status>` is `Accepted`, except when the existing promoted file's status already starts with `Superseded` or `Deprecated`: keep it. Never downgrade it. If the result is identical to the existing file, leave it untouched and report "unchanged".

5. **Supersession.** If the source has `supersedes: NNNN`: find `adr/NNNN-*.md`. If none exists, stop and report the error. Otherwise set its `status` to `Superseded by <new number>` (if not already). Change nothing else in that file.

6. **`adr/README.md` is static.** If it is missing, write exactly: heading `# Architecture Decision Records`, then one line: `One file per decision: \`NNNN-<slug>.md\`. List them with \`node openspec/scripts/verify-task.cjs adrs\`.` Never put a table or any per-ADR line in it (a generated table conflicts between parallel branches).

## Step 3: anchors, drift (script)

From the code repository root run `node openspec/scripts/verify-task.cjs sync <change>`. It writes nothing: it checks that the change is fully synced: specs merged, ADRs promoted with unique numbers, no orphan markers, stale test tags or unsynced archives. The `@spec` markers in the code are the anchor index: nothing is stored for them.

- If it exits 1, read `problems`, fix them (merge the missing spec block, promote the ADR, fix or remove the marker) and rerun. Gaps that are not about this change are listed as `drift:`; decide them with `/spec-garden`, do not paper over them.
- `--adrs-only` skips step 1 only; step 3 always runs.

## Summarize

```
## Synced: <change>
Specs:
- <capability>: added/modified/removed requirements ...
Anchors: <resolved | problems>; drift: <clean | N gaps, see /spec-garden>
ADRs:
- <slug>: promoted as adr/0004-<slug>.md | updated 0002-<slug>.md | unchanged | skipped (none)
- marked 0001-<slug>.md as Superseded by 0004
```
The change stays active; archive with `/spec-archive <change>` when implementation is complete (it syncs again first).

**Guardrails**
- Never edit the change's own `adrs/` files; they are the source. Only `adr/` is written in step 2.
- Never renumber or rename an existing promoted ADR, and never create a second file for a `source` that is already promoted.
- Running it twice in a row must change nothing the second time.
- Do not archive here.
- Never write a table in `adr/README.md` by hand: the README stays static.
