`apply.json` is the real output of `openspec instructions apply --change add-search --json` from @fission-ai/openspec 1.7.0 for the `tasks.md` next to it
(only the paths and the long `instruction` text are replaced). It has `id` (a running number, not the "1.1" label), `description` (the whole
checkbox text, label included) and `done` for each task: no `line` and no `sourcePath`. Later OpenSpec versions add both; this one is
what `tests/task-lines.sh` and the unit test must keep working with.
