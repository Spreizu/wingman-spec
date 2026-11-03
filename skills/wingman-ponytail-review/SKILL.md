---
name: wingman-ponytail-review
description: >
  Loaded by spec-implementer with wingman-requesting-code-review on a review task.
  Report Must fix / Should fix / Nice to have. YAGNI and lean are Should fix.
license: MIT
---
# Ponytail review

Read the diff of `review_range` and the code it touches. Report, then the implementer fixes Must fix and Should fix.

## Look for

1. Bug: wrong result, crash, missed edge, a caller broken by the change.
2. Risk: injection, secrets, swallowed errors, writes in the wrong order.
3. Scale: races, unbounded memory, a query per item, at the load this repo expects.
4. Missing test: risky new logic with no test that fails when it breaks.
5. Lean: dead code, unused options, a helper the repo already has, a new dependency for a few lines, an abstraction with one implementation.

A finding needs a concrete case. No case, no finding. Propose the smallest fix. Prefer deletes.

## Output

`What this change does:` in two or three sentences.

Then, skip empty groups:

- **Must fix:** bug, security, data loss, breaks at the expected load.
- **Should fix:** risky code without a test, real slowness, duplication, code that should not exist (including YAGNI / lean).
- **Nice to have:** small speed-ups.

Treat **Must fix** as Critical and **Should fix** as Important.

Copyright (c) Dietrich Gebert / ponytail. MIT. Rewritten for wingman-spec.
