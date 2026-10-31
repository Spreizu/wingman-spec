# Workspace layout: one specs repository for several code repositories

The [reference](reference.md#layouts-next-to-the-code-or-a-specs-repository) picks the layout. A single git repository
keeps its specs next to the code in `.wingman-spec/` and needs nothing on this page. This page is for a project with
2 or more code repositories (web, api, mobile, ...) that share one set of specs, changes and ADRs.

## Where everything goes

```
~/work/acme/                      the workspace folder (not a git repo itself)
  acme.code-workspace             optional, written by --workspace-file; open this in VS Code or Cursor
  specs/                          THE SPECS REPOSITORY: its own git repo, outside every code repo
    wingman-spec.yaml             shared settings: context, rules, defaults for the commands
    specs/ changes/ archive/ adrs/    specs, changes, archive and ADRs of ALL code repos
    runs/                         run state of the apply loop (ignores itself, never committed)
  web/  api/  mobile/             the code repos (separate git repos)
    .wingman-spec/wingman-spec.yaml   the link `specs: ../specs` + THIS repo's own commands
    .wingman-spec/bin/wingman-spec    the shim the agents call (gitignored)
    AGENTS.md                         the managed block
    .cursor/ .claude/ .agents/ .codex/    the /spec-* commands, subagents and skills, per --harness
```

The link is a relative path, so teammates who clone the repositories side by side share it. Several code repos can link
to one specs repository. Never create a `.wingman-spec/specs/` folder inside a linked code repo: it would become its own
root.

## Per-repo commands

Each code repo has its own test, typecheck and lint commands and its own app for the visual check. `init` detects them
in the repo being set up and writes them into **that repo's** `.wingman-spec/wingman-spec.yaml`, next to the link:

```yaml
specs: ../specs
specs_remote: https://git.example.com/acme/specs.git   # only a hint for the clone message below; no credentials
commands:
  test: npm test
  typecheck: npm run typecheck
  lint: none
visual:
  command: "npm run build && npm run preview -- --port 4173 --strictPort --host 127.0.0.1"
  url: http://127.0.0.1:4173/
```

Lookup order per key: **a flag or environment variable (`WINGMAN_SPEC_TEST_CMD`, ...) > the code repo's file > the
specs repository's `wingman-spec.yaml`**. The `visual:` block is merged per key too: a repo that sets only `command:` and
`url:` keeps the shared `review:`, `ready_timeout:` and so on, and `visual: off` in a repo turns the check off for that
repo only. A `<fill in>` in the repo's own file stops the lookup, so a repo never runs another repo's command: edit it, or
write `none`. `wingman-spec config` prints the merged settings and `wingman-spec root` both roots.

## Step by step

Needs `git` and the `wingman-spec` CLI ([install](install.md)). Below, `~/work/acme` holds the repos `web`, `api` and
`mobile`, and the specs repository will be `~/work/acme/specs`.

1. **Create the specs repository**, outside every code repo:
   ```bash
   mkdir -p ~/work/acme/specs && cd ~/work/acme/specs && git init
   wingman-spec init --layout specs --harness all
   ```
   `--harness` here lets you plan from inside the specs repository too; leave it out if you plan only from the code repos.
2. **Link every code repo**, with one shared workspace file:
   ```bash
   for r in web api mobile; do
     (cd ~/work/acme/$r && wingman-spec init --layout link --specs ../specs --harness all \
        --workspace-file ../acme.code-workspace)
   done
   ```
   Each run writes that repo's settings (the link and its detected commands), the shim, the `AGENTS.md` block and the
   agent files, and adds the repo and the specs repository to the workspace file. Read its output: a command it could not
   detect stays `<fill in>` (set it, or `none`). `--specs-remote <url>` records the clone URL; by default it is the
   specs repository's `origin`.
3. **Check each repo**: `cd ~/work/acme/api && wingman-spec doctor` lists what is still missing.
4. **Open the workspace** as one multi-root workspace: `code ~/work/acme/acme.code-workspace` (or `cursor ...`). Run
   `/spec-explore` and `/spec-propose` from any code repo's folder: the change is created in the specs repository.
5. **Commit in the right repo.** They stay separate git repositories:
   - the **specs repository** gets the specs, ADRs, changes and archive: `cd ~/work/acme/specs && git add -A && git commit`;
   - each **code repo** gets the code and the files `init` wrote (`.wingman-spec/wingman-spec.yaml`, `.wingman-spec/.gitignore`,
     `AGENTS.md`, the agent folders).

**A new code repo later**: run step 2 for it.

**After a CLI upgrade**: run `wingman-spec update` in each repo that has agent files. It rewrites the generated files and
the shim and leaves the settings and specs alone. Commit the result.

**Teammates**: push the specs repository and each code repo. A teammate installs the CLI, clones the specs repository and
the code repos side by side (the same relative paths as the links), and opens a workspace file with those folders (each
person can write one with `--workspace-file`, or you commit one). The shim is gitignored, so they run `wingman-spec update`
once in each code repo to write theirs.

## Troubleshooting

- `the specs repo is missing: <path>`: the code repo's `specs: ../specs` points at a folder that does not exist on this
  machine, usually a teammate's. Nothing is cloned for you. The message prints the `git clone` line; its URL comes from
  `specs_remote:` (without it, ask whoever set the project up). For a single run you can also pass `--root <dir>` of a
  clone you already have. Every `wingman-spec` command prints the same text, and the `/spec-*` commands show it to you
  and stop instead of guessing a root.
- `has no wingman-spec.yaml: run wingman-spec init --layout specs there first`: `init --layout link` was pointed at a
  folder that is not a specs repository yet.
- `the project test command in <file> is still the <fill in> placeholder` (or `commands.lint is still <fill in>`):
  `init` could not detect that repo's command; edit the file it names (the repo's own `.wingman-spec/wingman-spec.yaml`),
  or write `none`.
- A repo runs the wrong command: `wingman-spec config` shows the merged value; edit the key in the code repo's file (an
  environment variable or flag wins over both files).

## How the pieces adapt

The root is found from the current directory: `.wingman-spec/` with its own `specs/` (next to the code), a
`wingman-spec.yaml` at a repository root (a specs repository), or `.wingman-spec/wingman-spec.yaml` with `specs:` (a
linked code repo). `--root <dir>` or `WINGMAN_SPEC_ROOT` overrides the lookup. The CLI runs in the code repo, reads and
ticks `tasks.md` in the specs repository, and keeps the run state in `runs/<change>/` of the specs repository, so separate
worktrees of one code repo share it. The shim, the visual helper and the cache stay in the code repo's `.wingman-spec/`.
The VS Code extension follows the same link. Drift is computed per code repo against the shared specs: a requirement
implemented in another repo shows as unanchored there (accept it with `drift decide`).
