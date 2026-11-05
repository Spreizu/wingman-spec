---
name: wingman-test-driven-development
description: >
  Loaded by spec-implementer for every implementation task. Write the failing test named in Test first:,
  watch it fail, then write the least code that passes.
license: MIT
---
# Test-driven development

The implementer prompt states the loop: one failing test, see it fail, least code that passes, then refactor while tests stay green. This file adds the checks that sentence does not.

## Checks

1. Confirm the failure is the behaviour you named. A compile error or a wrong assertion is not that failure.
2. Put `[capability/scenario-slug]` in the test title when the task lists that id.
3. Do not write production code before that failing test.
4. Do not skip the red run because you expect the failure.
5. Do not add cases the spec did not ask for (see `wingman-ponytail`).
