# Workspace layout: several git repos with one store

The table in the [reference](reference.md#two-layouts-one-repo-or-a-workspace-with-several-repos) picks the layout. This page has the folder layout, the per-repo commands, the install steps, the teammate steps and the error messages.

## Where everything goes (workspace with a store)

```
~/work/acme/                      the workspace folder (not a git repo itself)
  acme.code-workspace             optional, written by --workspace-file; open this in VS Code / Cursor
  specs/                          THE STORE: its own git repo, OUTSIDE every code repo
    openspec/schemas/wingman-spec/     the schema (installed once, shared)
    openspec/config.yaml               shared config: context, rules, and DEFAULT commands (see below)
    openspec/specs/  openspec/changes/  adr/    specs, changes and ADRs of ALL repos
  web/  api/  mobile/             the code repos (separate git repos)
    openspec/config.yaml               pointer `store: acme` + THIS repo's own commands (see below)
    openspec/scripts/                  verify-task.cjs and friends (run from here, inside the code repo)
    AGENTS.md                          the managed block
    .cursor/ .claude/ .agents/ .codex/ the /spec-* commands, subagents, skills and prompt-guard hook, per --harness
```

The installer is run from the **unpacked schema folder** (anywhere, e.g. `~/tools/wingman-spec`); it is not copied
into the projects. Install the store once, then run `install.sh` for each code repo.

**Per-repo commands.** Each code repo has its own test, typecheck and lint commands and its own app for the visual check.
In a workspace layout the installer detects them from the repo being installed and writes them into **that repo's**
`openspec/config.yaml` (the `workspace.yaml` for `--specs`), next to the pointer:

```yaml
store: acme
store_remote: https://git.example.com/acme/specs.git   # only a hint for the teammate error below; no credentials
verify: |
  - Test command: `npm test`
  - Typecheck command: `npm run typecheck`
  - Lint command: none
visual:
  command: "npm run build && npm run preview -- --port 4173 --strictPort --host 127.0.0.1"
  url: http://127.0.0.1:4173/
```

`verify-task.cjs` reads each key from the code repo's file first and falls back to the store's `openspec/config.yaml`.
Order per key: **`--test-cmd` / `SPEC_TEST_CMD` / `SPEC_TYPECHECK_CMD` / `SPEC_LINT_CMD` > the code repo's file > the
store's config**. The `visual:` block is merged per key too (a repo that only sets `command:` and `url:` keeps the
store's `review:`, `ready_timeout:`, ...; `visual: off` in the repo turns it off for that repo only). A `<fill in>` in the
repo's own file stops the lookup, so a repo never runs another repo's command: edit it (or write `none`). The installer
never overwrites a key that is already in the file; re-running it adds only what is missing. The store's own
`openspec/config.yaml` gets test/lint/visual defaults only while it has none (taken from the first repo installed) and is
never changed by later installs. `node openspec/scripts/verify-task.cjs doctor` (run inside a code repo) prints the
**source file of every command**. The `openspec` CLI accepts the extra keys (`verify:`, `visual:`) next to `store:`.

## Step by step: a workspace with several git repos

Needs `git`, Node.js and the `openspec` CLI on PATH. Below, `~/work/acme` holds the repos `web`, `api` and `mobile`
and the store will be `~/work/acme/specs` with the id `acme`.

1. **Get the schema** (from the delivered bundle, or unzip `wingman-spec.zip`; the zip needs no git):
   ```bash
   git clone wingman-spec.bundle -b main wingman-spec
   cd wingman-spec
   ```
   (The zip unpacks to a `wingman-spec/` folder.) Keep this folder: every `install.sh` run below starts from it.
2. **Git identity** (`openspec store setup` makes the first commit and fails without one):
   ```bash
   git config --global user.name "Your Name"
   git config --global user.email "you@example.com"
   ```
3. **Create and register the store**, outside every code repo. `--remote` records where teammates clone it from (optional):
   ```bash
   openspec store setup acme --path ~/work/acme/specs --remote git@github.com:acme/specs.git
   openspec store list          # acme -> ~/work/acme/specs
   ```
4. **Install into every code repo**, from the schema folder, with the same `--store` and one shared workspace file:
   ```bash
   for r in web api mobile; do
     ./install.sh ~/work/acme/$r --store acme --harness all --workspace-file ~/work/acme/acme.code-workspace
   done
   ```
   `--harness` is `cursor` (default), `claude`, `codex`, or a list / `all`. The first run writes the store's schema and
   shared config; each run writes that repo's pointer, commands, scripts, `AGENTS.md` block and harness files, and adds the
   repo (and the store) to the workspace file. Read its output: it says which test/typecheck/lint/visual commands it
   found for the repo; a command it could not detect is written as `<fill in>` (set it, or `none`).
5. **Check each repo**: `cd ~/work/acme/api && openspec doctor && node openspec/scripts/verify-task.cjs doctor`.
   The first confirms the store pointer resolves, the second lists each command with its source file.
6. **Open the workspace** as one multi-root workspace: `code ~/work/acme/acme.code-workspace` (or `cursor ...`;
   or File > Open Workspace from File). Run `/spec-explore` / `/spec-propose` from any code repo's folder: the change is
   created in the store.
7. **Commit in the right repo.** They stay separate git repositories:
   - the **store** gets specs, ADRs and changes (`/spec-sync`, `/spec-archive`) and the installed schema/config:
     `cd ~/work/acme/specs && git add -A && git commit -m "..."`;
   - each **code repo** gets the code and what the installer put in it (the pointer file, `openspec/scripts/`,
     `AGENTS.md`, the harness folders): `cd ~/work/acme/api && git add -A && git commit -m "Add OpenSpec"`.
   Never create `openspec/specs` or `openspec/changes` inside a code repo: it would become its own root, and the
   installer refuses to link such a repo.

**A new code repo later**: run step 4's `./install.sh <repo> --store acme ...` for it (the `--workspace-file` adds the folder).

**Update the schema or re-install**: get the new version into the schema folder (`cd wingman-spec && git pull
<new bundle> main`, or unzip the new zip over a fresh folder) and run the step 4 loop again. It is idempotent: the schema,
scripts, skills and generated harness files are always overwritten (keep local changes in git), keys already in a
repo's file or in the store config are left alone, and a `.suggested` file is written instead of touching a config that
is not ours. Commit the resulting changes in the store and in each code repo.

**Teammates**: share the store by pushing it (`cd ~/work/acme/specs && git remote add origin <url> && git push -u origin
main`; use the same URL as `--remote`) and push each code repo (it carries the pointer, commands and scripts). A teammate
needs no installer: `git clone <store url> ~/work/acme/specs`, `openspec store register ~/work/acme/specs` (the id `acme`
comes from the store's metadata; skipping this gives the "not registered" error below, which repeats these two commands
with the real URL), clone the code repos next to it, and open a workspace file with those folders (each person can write theirs with `--workspace-file`, or you commit one). Run `install.sh` only to pick up a newer schema, or to
add a harness they use.

**Troubleshooting**
- `install: store 'nope' is not registered.` / `Unknown store 'acme'. No stores are registered.`: the store id in the
  pointer is not registered on this machine. `openspec store list` shows what is; create it with
  `openspec store setup <id> --path <dir>` or register an existing clone with `openspec store register <dir>`.
- `No usable Git commit identity is configured, so setup cannot create the initial store commit.`: step 2.
- `verify-task: OpenSpec store 'acme' is not registered on this machine.` (and `openspec`'s own `Unknown store 'acme'`):
  you are on a machine, usually a teammate's, where the code repo's `store: acme` pointer has no store behind it. The id
  is a pointer to a folder registered on this machine, not a URL, and nothing is cloned for you. The message lists the
  steps: `git clone <store url> <dir>`, then `openspec store register <dir>`, then run the command again. The URL in
  the message comes from `store_remote:` in the repo's `openspec/config.yaml` (the installer records it, without
  credentials, when the store has a `--remote` or an `origin`); without it the message says `<store repo url>`: ask
  whoever set the store up. For a single run you can also pass `--root <dir>` of a clone you already have.
  The same text is printed by every `verify-task.cjs` command (`doctor`, `next`, `check`, `status`, `lint`, ...), and
  the `/spec-*` commands show it to you and stop instead of guessing a root.
- `... store 'acme' is registered on this machine (<path>), but that folder is missing or is not a usable OpenSpec
  store`: the registration points at a folder that was moved, deleted or never had its `.openspec-store/store.yaml`.
  Run `openspec store doctor acme`; to start over, clone the store again, `openspec store unregister acme` (forgets
  the registration only), `openspec store register <dir>`.
- `verify-task: the specs repo is missing: <path>` (`--specs` layout): clone the specs repo to that path, which is
  relative to the code repo (`specs: ../specs` in `openspec/workspace.yaml`); `specs_remote:` there holds the URL.
- `verify-task: cannot find the OpenSpec root ...` (no pointer at all): run it from inside a code repo that has the
  pointer, or pass `--store <id>` / `--root <dir>`.
- `the project test command in <file> is still the <fill in> placeholder`: the installer could not detect that repo's
  test command; edit the file it names (the repo's own `openspec/config.yaml`), or write `none`.
- A repo runs the wrong command: `verify-task.cjs doctor` shows the source file; edit the key in that file (an
  environment variable or CLI flag wins over both files).

## The same with a plain specs repo (no registry)

`./install.sh <code-repo> --specs <specs-repo> [--workspace-file proj.code-workspace]`: the specs repo (a directory you
created and `git init`ed) holds the schema, config, specs, changes and ADRs; each code repo gets `openspec/workspace.yaml`
(`specs: ../specs-repo`, relative so teammates with the same sibling layout share it) with the same per-repo commands
and `visual:` block, plus the scripts, `AGENTS.md` block, skills and `/spec-*` commands. Several code repos can link to
one specs repo. Everything above about where files go, per-repo commands, precedence and commits applies; there is no
`store setup` or `register` step, teammates just clone the specs repo to the same relative place.

## How the pieces adapt

The root is found in this order: specs next to the code, `workspace.yaml` link, `store:` pointer. The `/spec-*` commands
run `openspec` from the root (`cd <root> && openspec ...`) and read and write `openspec/...` and `adr/` there. With no
link, they look for the one other workspace folder that has an OpenSpec root. `openspec/scripts/verify-task.cjs`
runs in the code repo, finds `tasks.md` and `BLOCKED.md` in the store and ticks `tasks.md` there. `--root <dir>` or
`--store <id>` overrides the lookup. The VS Code extension follows the same link. To plan from inside the store too, run `./install.sh <store-dir>` (a plain install there adds
commands, skills and `AGENTS.md`).
