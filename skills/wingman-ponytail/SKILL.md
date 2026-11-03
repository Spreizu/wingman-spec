---
name: wingman-ponytail
description: >
  Loaded by spec-implementer for every implementation task (full). Smallest change
  that meets the spec. Ends when the task ends; it does not stay on in the parent chat.
license: MIT
---
# Ponytail

This skill applies to this task only. When the task ends, stop.

Solve the whole task with the least new code. In your reply, name what you skipped.

## Before you write

Read the task and the code it touches. Callers, tests, fixtures, config. That is scope. Extra features are not.

## Pick the first option that fully works

1. Skip options nobody asked for, and name them in one line.
2. Reuse what this codebase already does the same way.
3. Prefer the standard library or a dependency already installed. Do not add a package for a few lines.
4. One clear line beats a new helper. Deletion beats addition.
5. Finish every caller, test and fixture the change breaks.

Never cut: validation at trust boundaries, error handling that prevents data loss, security, accessibility, or anything the spec asked for. New non-trivial logic leaves a test.

Copyright (c) Dietrich Gebert / ponytail. MIT. Rewritten for wingman-spec.
