# Install and upgrade

Wingman Spec is one binary, `wingman-spec`, for Linux, macOS and Windows on x64 and arm64. The commands, subagents,
skills, artifact templates and the visual check's helper are built into it. The visual check also needs Node 22,
Playwright and Chromium in the project; `wingman-spec doctor` says what is missing.

## Install the extension

Install **Wingman Spec** (`elmo-egers.wingman-spec`) from the VS Code Marketplace, or from Open VSX in Cursor. The
editor picks the build for its platform (`linux`, `darwin` or `win32`, each `x64` and `arm64`). That build carries the
CLI in its `bin/` folder, and the CLI is always that bundled copy. Each release also has the vsix files for manual
installs ("Extensions: Install from VSIX..."): `wingman-spec-<platform>-<version>.vsix`.

## Set up a project

Open the project folder and run **Wingman Spec: Set Up This Folder**. Pick the layout: specs next to the code, a specs
repository, or a code repository linked to one. The extension runs the bundled `wingman-spec init --harness all` there.

This writes `.wingman-spec/` with the settings and empty specs, changes, archive and ADR folders, the agent files of
each harness, the `AGENTS.md` block and the shim. Commit `.wingman-spec/` and the agent files; the `.gitignore` inside
`.wingman-spec/` keeps `runs/`, `bin/`, `cache/` and `local/` out of git. A project whose specs live in their own
repository: [docs/workspace-layout.md](workspace-layout.md).

## The shim

`.wingman-spec/bin/wingman-spec` is a link to the extension's bundled CLI (a `.cmd` file on Windows). The `/spec-*`
commands, the subagents and the dashboard's terminal buttons call the CLI through it, so committed files
never name the extension's install folder, which differs per version and machine. It is gitignored and per clone.
Whenever the extension starts in a folder with `.wingman-spec/`, it creates the shim, or points it at the bundled CLI
again when it is missing, broken or names another binary. That also happens in specs repositories, in each folder
of a multi-root workspace and after an extension update. It asks nothing and writes one line to the **Wingman Spec**
output channel.

## Upgrade

The extension updates through the editor, and the shim follows it. When the project's generated agent files are older
than the bundled CLI, one notification offers **Run update**. That runs `wingman-spec update`, which rewrites the
generated agent files, the bundled skills, the `AGENTS.md` block and the shim. It never runs by itself, because those
files are committed. Your settings, specs, changes and ADRs are not touched. Review and commit what changed.

## From the OpenSpec-based 0.11 release

0.11 was an OpenSpec schema with Node scripts copied into each project. Convert a project once:

```bash
wingman-spec import openspec --dry-run   # list the steps
wingman-spec import openspec             # openspec/ and adr/ become .wingman-spec/
wingman-spec init --harness all          # the agent files, AGENTS.md block and shim for 0.12
```

Run them as `.wingman-spec/bin/wingman-spec` once the extension has written the shim, or run **Wingman Spec: Set Up
This Folder** for the last step.

The import moves the living specs (`specs/<capability>/spec.md` becomes `specs/<capability>.md`), the changes, the
archive, the ADRs, the roadmap and greenfield records, and turns the `config.yaml` context lines into `commands:` keys.
It prints a warning for anything it could not carry over. A shared store of OpenSpec specs becomes a specs repository with
`--to .`, run in the store folder; then run `wingman-spec init --layout link --specs <path>` in each code repository and
delete its old `openspec/` folder. `init` then rewrites the `/spec-*` commands and subagents. The `openspec` CLI is no longer
needed.

`init` never edits hook files, so the 0.11 prompt hook stays until you delete it: the `spec-guard.cjs` entry in
`.cursor/hooks.json`, `.claude/settings.json` and `.codex/hooks.json`, and the `spec-guard.cjs` files next to them.
