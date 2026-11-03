---
name: wingman-test-driven-development
description: >
  Loaded by spec-implementer for every implementation task. Write the failing test named in Test first:,
  watch it fail, then write the least code that passes.
license: MIT
---
# Test-driven development

The CLI ticks a task only when its tests pass. You still have to watch the test fail first, or you do not know it tests the right thing.

## Loop

1. Write one test that names the behaviour in `Test first:`. Put `[capability/scenario-slug]` in its title when the task lists that id.
2. Run it. Confirm it fails for the reason you intend (not compile error, not a wrong assertion).
3. Write the least code that makes it pass. Do not keep code you wrote before the test.
4. Refactor only while the tests stay green.
5. Repeat for the next behaviour in the task. Stop when the task is done.

## Do not

- Write production code before a failing test.
- Skip the red run "because you know it will fail".
- Broaden the test to cover extras the spec did not ask for (see `wingman-ponytail`).
- Tick `tasks.md`. The CLI ticks it after `check` passes.
