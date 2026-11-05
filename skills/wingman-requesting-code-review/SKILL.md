---
name: wingman-requesting-code-review
description: >
  Loaded by spec-implementer for a Request code review task. Diff the packet's
  review_range (BASE_SHA and HEAD_SHA). Do not run git rev-parse HEAD~1.
license: MIT
---
# Requesting code review

The prompt gives `review_range`: `BASE_SHA` and `HEAD_SHA`. They cover the whole uncommitted change. Diff those two SHAs. Never derive the range yourself.

## Do

1. `git diff BASE_SHA HEAD_SHA` (and the files the prompt lists).
2. Also apply `wingman-ponytail-review`.
3. Fix Critical and Important before you reply. First add a test that fails without the fix (`[review:<slug>]` in the name).
4. Record each fix: `.wingman-spec/bin/wingman-spec progress <change> --task <id> --review-fix <slug> --note "<finding>"`. Use `--untestable "<reason>"` when no test can show it.
5. Stay inside files this change's `Files:` lines name. Put anything outside in your reply as a follow-up.

## Do not

- Use `git rev-parse HEAD~1` as the base.
- Commit, tick tasks, or edit specs.
