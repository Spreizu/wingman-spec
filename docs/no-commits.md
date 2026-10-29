# No commits during a change

The workflow never creates a git commit. Every task, fix, sync and archive of a change leaves its work in the working tree, so the user reviews the whole change at once and commits it once, or in chunks, when it is finished.

Why:

- A commit per task splits one reviewable change into pieces that are only meaningful together; the person who owns the repository decides the history.
- Nothing the verifier decides depends on a commit. A passing check records HEAD and the hash of the task's `Files:`; the record is valid while HEAD is in the same history or the files are identical, and HEAD does not move when nothing is committed. `finish` is current while the hash of the whole working tree is unchanged, so committing afterwards (same tree) does not make it stale. The result cache is keyed on the working tree, and the anchor guard and the scope check diff the working tree against the commit `next` recorded (committed or not, plus untracked files).
- Branch Review compares the working tree and untracked files with the merge base, so it works before anything is committed.
- The verifier only reads git. It builds its tree hashes in a temporary index and takes the fallback "before" capture from a throwaway worktree of HEAD; it never stages, commits, stashes, resets or switches branches in the repository.

When committing, keep a requirement's spec text and the code and tests that carry its `@spec` anchor in the same commit: stale-anchor drift (`V drift`, advisory by default) compares the last commit of a requirement's text with the last commit of its anchored code, and ignores a code commit that also touches the requirement's spec. Committing all specs first and the code afterwards makes every anchored unit look stale until the spec is touched again.

Code review without commits. The vendored `requesting-code-review` skill diffs two git SHAs and suggests `git rev-parse HEAD~1` for the base, which assumes one commit per task. The workflow does not edit that skill; the review task's packet (`next`, JSON and prompt) carries `review_range` instead: `BASE_SHA` is the commit the change's first run started from, `HEAD_SHA` an unreferenced commit of the working tree as it is now. It is built from a temporary index (`git add -A` into it, so tracked edits, staged edits and untracked files that are not ignored are in; run logs are left out), `git write-tree` and `git commit-tree -p BASE_SHA` with a fixed date, so the same tree gives the same SHA. The user's index, branch, HEAD, stash and `git log` do not change; the object has no ref and is garbage collected later. `git diff BASE_SHA HEAD_SHA` is the whole uncommitted change, and both SHAs stay valid if the user commits afterwards. The implementer is told to use these values and not to derive the range itself. A review task is dispatched alone, so a group review (Size M/L) uses the same run-start base.

`AGENTS.md` carries the one operational rule. The implementer's prompt and the fix prompt repeat only "do not commit" for the subagent that reads nothing else.
