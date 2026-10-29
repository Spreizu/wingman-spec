#!/usr/bin/env bash
# install.sh - install the wingman-spec OpenSpec schema package into a project.
#
# Usage: ./install.sh <target-project-dir> [--harness cursor,claude,codex|all] [--specs <dir> | --store <id>]
#                     [--workspace-file <file>]
#
# Installs (idempotent; safe to re-run):
#   openspec/schemas/wingman-spec/     the schema + templates           (overwritten: package-managed)
#   openspec/scripts/verify-task.cjs, visual-check.cjs, quality.cjs, design-contract.cjs, traceability.cjs, placement.cjs, testpaths.cjs, anchorguard.cjs, anchorfit.cjs, chronology.cjs, timeline.cjs, runstate.cjs, problems.cjs, roles.cjs, greenfield.cjs  (overwritten: package-managed)
#   AGENTS.md                          managed block between WINGMAN-SPEC markers (created/updated)
#   openspec/config.yaml               created if missing; otherwise a .suggested file is written. The test command
#                                      and the visual check's app command/URL are detected from the code repo
#                                      (package.json scripts and vite/next, pytest/unittest, go, cargo, make).
#                                      In a workspace layout (--store/--specs) the root config is shared by every code
#                                      repo and only gets these as defaults while it has none; each repo's own
#                                      commands are written to ITS pointer file (below), where they win per key.
#   per harness (--harness; default cursor), generated from project-template/harness/ by scripts/render-harness.sh:
#     cursor  .cursor/commands/spec-*.md, .cursor/agents/spec-implementer.md, .cursor/skills/<skill>/,
#             .cursor/hooks.json beforeSubmitPrompt guard
#     claude  .claude/commands/spec-*.md, .claude/agents/spec-implementer.md, .claude/skills/<skill>/,
#             .claude/settings.json UserPromptSubmit guard, `@AGENTS.md` import in CLAUDE.md
#     codex   .agents/skills/spec-*/ (invoked as $spec-*), .codex/agents/spec-implementer.toml,
#             .agents/skills/<skill>/, .codex/hooks.json UserPromptSubmit guard (runs once the project is trusted)
#   Bundled skills: grilling, test-driven-development, ponytail, systematic-debugging, requesting-code-review,
#   ponytail-review, verification-before-completion; first party: figma-to-code (builds or updates UI from a Figma URL;
#   its script needs only Node) and spec-writing (short, concrete specs). The guard blocks stock /opsx:* and suggests /spec-*.
#   Generated files (commands, agents, skills, scripts, schema, the AGENTS.md block) are always overwritten on
#   reinstall; keep local changes in git. Text outside the AGENTS.md block is never touched.
#
# Two layouts (the "OpenSpec root" is the directory that contains openspec/):
#   next to code (default)  the target is both the code repo and the OpenSpec root. One repo only.
#   workspace (--store ID)  USE THIS when one workspace holds SEVERAL git repos. The specs live in ONE registered
#                           OpenSpec store (a separate git repo outside every code repo; create it once with
#                           `openspec store setup ID --path DIR`, see `openspec store list`). Run install.sh once per
#                           code repo. Each code repo gets openspec/config.yaml = `store: ID` plus ITS OWN
#                           `verify: |` commands and `visual:` block (detected from that repo, never overwritten once
#                           present), openspec/scripts, an AGENTS.md block, skills and commands per harness. The store
#                           gets the schema and the shared config.
#   workspace (--specs DIR) same without a registry: DIR is a separate specs repo (usually a sibling); the code repo
#                           gets openspec/workspace.yaml (`specs: <relative path>`) holding the same per-repo commands.
#   If the store has a remote (`store setup --remote`, or a git `origin`) the pointer also records it as `store_remote: URL`
#   (`specs_remote:` for --specs; credentials are stripped), so a teammate who has not cloned/registered the store gets
#   an error from verify-task.cjs that names `git clone URL <dir>` and `openspec store register <dir>`.
#   Precedence per command/visual key: CLI flag or env var > the code repo's pointer file > the store's config.yaml.
#
# Options:
#   --specs DIR      workspace layout with a separate specs repo (above). No registry needed.
#   --store ID       workspace layout with a registered OpenSpec store (above): the layout for several git repos.
#   --workspace-file FILE  with --specs/--store: also write a .code-workspace that opens both folders. If it exists
#                    (use the same file for every code repo of the workspace) a missing code or specs folder is
#                    added when the file is plain JSON; anything else is left untouched.
#   --harness LIST   comma-separated cursor, claude, codex, or all (default: cursor)

set -euo pipefail

PKG="$(cd "$(dirname "$0")" && pwd)"
TARGET=""
STORE=""
SPECS=""
WORKSPACE_FILE=""
HARNESSES=""

while [ $# -gt 0 ]; do
  case "$1" in
    --store) STORE="${2:?--store needs a store id}"; shift ;;
    --specs) SPECS="${2:?--specs needs the specs repo directory}"; shift ;;
    --workspace-file) WORKSPACE_FILE="${2:?--workspace-file needs a file path}"; shift ;;
    --harness) HARNESSES="$HARNESSES,${2:?--harness needs cursor,claude,codex or all}"; shift ;;
    -h|--help) sed -n '2,43p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "install: unknown option $1" >&2; exit 2 ;;
    *) TARGET="$1" ;;
  esac
  shift
done

[ -n "$TARGET" ] || { echo "usage: install.sh <target-project-dir> [--harness cursor,claude,codex|all] [--specs <dir> | --store <id>] [--workspace-file <file>]" >&2; exit 2; }
# --harness: default cursor; "all" = every harness; validated before anything is written.
case ",$HARNESSES," in *,all,*) HARNESSES="cursor,claude,codex" ;; ,,) HARNESSES="cursor" ;; esac
HARNESS_LIST=""
for h in $(printf '%s' "$HARNESSES" | tr ',' ' '); do
  case "$h" in cursor|claude|codex) case " $HARNESS_LIST " in *" $h "*) ;; *) HARNESS_LIST="$HARNESS_LIST $h" ;; esac ;;
    *) echo "install: unknown harness '$h' (cursor, claude, codex, all)" >&2; exit 2 ;; esac
done
has_harness() { case " $HARNESS_LIST " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
[ -d "$TARGET" ] || { echo "install: target directory does not exist: $TARGET" >&2; exit 2; }
TARGET="$(cd "$TARGET" && pwd)"
if [ -f "$TARGET/AGENTS.md" ] && [ "$(grep -c 'WINGMAN-SPEC:START' "$TARGET/AGENTS.md")" != "$(grep -c 'WINGMAN-SPEC:END' "$TARGET/AGENTS.md")" ]; then
  echo "install: $TARGET/AGENTS.md has unbalanced WINGMAN-SPEC:START/END markers; fix them by hand (nothing was changed)." >&2
  exit 2
fi
[ -z "$STORE" ] || [ -z "$SPECS" ] || { echo "install: use --specs or --store, not both" >&2; exit 2; }
[ -z "$WORKSPACE_FILE" ] || [ -n "$STORE$SPECS" ] || { echo "install: --workspace-file needs --specs or --store" >&2; exit 2; }

say() { echo "  $*"; }
# yaml_value KEY FILE: the first top-level `KEY: value`, without quotes or a trailing comment (no regex on the value).
yaml_value() { sed -n -E "s/^$1:[[:space:]]*//p" "$2" | head -n1 | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]*$//' | tr -d "\"'"; }

# Clone URL of the specs/store repo, so a teammate's "store not registered" error can name it. Sources: the store's
# .openspec-store/store.yaml `remote:` (from `openspec store setup --remote`), else the git `origin` of the folder.
# Credentials in URLs (user:pass@, tokens) are never recorded: userinfo is stripped from scheme URLs.
detect_remote() {
  local d="$1" u=""
  [ -f "$d/.openspec-store/store.yaml" ] && u="$(yaml_value remote "$d/.openspec-store/store.yaml")"
  [ -n "$u" ] || u="$(git -C "$d" remote get-url origin 2>/dev/null || true)"
  printf '%s' "$u" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^/@]*@#\1#' | tr -d '\r\n'
}
# add_remote_hint FILE KEY AFTER_KEY URL: adds `KEY: URL` right after the AFTER_KEY line unless KEY is already there.
add_remote_hint() {
  local f="$1" k="$2" after="$3" u="$4"
  [ -n "$u" ] || return 0
  grep -qE "^$k:" "$f" && return 0
  node -e '
    const fs = require("fs"); const [f, k, after, u] = process.argv.slice(1);
    const L = fs.readFileSync(f, "utf8").split("\n"); const i = L.findIndex((l) => l.startsWith(after + ":"));
    if (i < 0) process.exit(0);
    L.splice(i + 1, 0, `${k}: ${u}`);
    fs.writeFileSync(f, L.join("\n"));' "$f" "$k" "$after" "$u" && say "remote hint -> $k: $u (in $(basename "$f"); lets a teammate's error name the clone URL)"
}

# OpenSpec root: the target itself (next to code) or a registered store (workspace).
ROOT_DIR="$TARGET"
if [ -n "$STORE" ]; then
  command -v openspec >/dev/null 2>&1 || { echo "install: --store needs the 'openspec' CLI on PATH" >&2; exit 2; }
  ROOT_DIR="$(openspec store list --json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const j = JSON.parse(s.slice(s.indexOf("{")));
        const hit = (j.stores || []).find(x => x.id === process.argv[1]);
        if (!hit) process.exit(1);
        console.log(hit.root);
      } catch (e) { process.exit(1); }
    });' "$STORE")" || {
    echo "install: store '$STORE' is not registered. See 'openspec store list'," >&2
    echo "         or create/register it: openspec store setup $STORE --path <dir>  |  openspec store register <dir>" >&2
    exit 2
  }
  ROOT_DIR="$(cd "$ROOT_DIR" && pwd)"
  [ -d "$ROOT_DIR/openspec" ] || { echo "install: store '$STORE' at $ROOT_DIR has no openspec/ directory (run 'openspec store doctor $STORE')" >&2; exit 2; }
  [ "$ROOT_DIR" != "$TARGET" ] || { echo "install: the target is the store itself; run without --store" >&2; exit 2; }
  if [ -d "$TARGET/openspec/specs" ] || [ -d "$TARGET/openspec/changes" ]; then
    echo "install: $TARGET/openspec already has specs/ or changes/, so it is a real OpenSpec root and a 'store:' pointer would be ignored." >&2
    echo "         Move or remove them to use the workspace layout, or install without --store (next to code)." >&2
    exit 2
  fi
  echo "Installing wingman-spec schema package: code in $TARGET, OpenSpec workspace '$STORE' at $ROOT_DIR"
elif [ -n "$SPECS" ]; then
  [ -d "$SPECS" ] || { echo "install: --specs directory does not exist: $SPECS (create the specs repo first)" >&2; exit 2; }
  ROOT_DIR="$(cd "$SPECS" && pwd)"
  [ "$ROOT_DIR" != "$TARGET" ] || { echo "install: the target is the specs repo itself; run without --specs" >&2; exit 2; }
  if [ -d "$TARGET/openspec/specs" ] || [ -d "$TARGET/openspec/changes" ]; then
    echo "install: $TARGET/openspec already has specs/ or changes/, so the specs are next to the code and a link to $ROOT_DIR would be ambiguous." >&2
    echo "         Move or remove them to use the workspace layout, or install without --specs (next to code)." >&2
    exit 2
  fi
  [ -d "$ROOT_DIR/openspec" ] || echo "  note: $ROOT_DIR has no openspec/ yet; creating the skeleton (config, specs/, changes/)."
  echo "Installing wingman-spec schema package: code in $TARGET, specs repo at $ROOT_DIR"
else
  echo "Installing wingman-spec schema package into $TARGET"
  if [ ! -d "$TARGET/openspec" ]; then
    echo "  note: no openspec/ directory yet. Run 'openspec init --tools cursor' in the project (before or after this installer)."
  fi
fi

# 1. schema (always into the OpenSpec root) --------------------------------------------------
mkdir -p "$ROOT_DIR/openspec/schemas"
[ -z "$SPECS" ] || mkdir -p "$ROOT_DIR/openspec/specs" "$ROOT_DIR/openspec/changes"
rm -rf "$ROOT_DIR/openspec/schemas/wingman-spec"
cp -R "$PKG/schemas/wingman-spec" "$ROOT_DIR/openspec/schemas/wingman-spec"
if [ -n "$STORE$SPECS" ]; then say "schema      -> $ROOT_DIR/openspec/schemas/wingman-spec/"; else say "schema      -> openspec/schemas/wingman-spec/"; fi

# 2. scripts (into the code repo, under openspec/) ----------------------------------------------
mkdir -p "$TARGET/openspec/scripts"
for f in verify-task.cjs visual-check.cjs quality.cjs design-contract.cjs traceability.cjs placement.cjs testpaths.cjs anchorguard.cjs anchorfit.cjs chronology.cjs timeline.cjs runstate.cjs problems.cjs roles.cjs greenfield.cjs; do
  cp "$PKG/project-template/openspec/scripts/$f" "$TARGET/openspec/scripts/$f"
  chmod +x "$TARGET/openspec/scripts/$f"
done
say "scripts     -> openspec/scripts/{verify-task.cjs,visual-check.cjs,quality.cjs,design-contract.cjs,traceability.cjs,placement.cjs,testpaths.cjs,anchorguard.cjs,anchorfit.cjs,chronology.cjs,timeline.cjs,runstate.cjs,problems.cjs,roles.cjs,greenfield.cjs}"
# A new product (no code, no specs yet) gets the analyst's inputs folder with a short README; any other project is left alone.
if [ -z "$STORE$SPECS" ]; then
  gf_out="$(node "$TARGET/openspec/scripts/greenfield.cjs" greenfield readme --root "$TARGET" 2>/dev/null || true)"
  case "$gf_out" in wrote*) say "inputs      -> openspec/inputs/README.md (new product: put the client material here, then run /spec-green-start)" ;; esac
fi
# Visual roles: login sessions and local credentials live in openspec/.local/, a folder that ignores itself (no project .gitignore edit).
mkdir -p "$TARGET/openspec/.local"; [ -e "$TARGET/openspec/.local/.gitignore" ] || printf '*\n' > "$TARGET/openspec/.local/.gitignore"
say "local       -> openspec/.local/ (visual role sessions and credentials stay local; the folder ignores itself)"

# 3. AGENTS.md managed block ---------------------------------------------------------------
BLOCK="$PKG/project-template/AGENTS.block.md"
AGENTS="$TARGET/AGENTS.md"
if [ ! -f "$AGENTS" ]; then
  cp "$BLOCK" "$AGENTS"
  say "AGENTS.md   -> created"
else
  tmp="$(mktemp)"
  if grep -q 'WINGMAN-SPEC:START' "$AGENTS"; then
    awk -v blockfile="$BLOCK" '
      BEGIN { while ((getline l < blockfile) > 0) block = block l "\n" }
      /WINGMAN-SPEC:START/ { printf "%s", block; skip = 1; next }
      /WINGMAN-SPEC:END/   { skip = 0; next }
      !skip { print }
    ' "$AGENTS" > "$tmp"
  else
    { cat "$AGENTS"; [ -n "$(tail -c1 "$AGENTS")" ] && echo; echo; cat "$BLOCK"; } > "$tmp"
  fi
  # awk ends every line with a newline: a file that had none keeps none (the last human line stays byte-identical)
  if [ -n "$(tail -c1 "$AGENTS")" ] && [ -s "$tmp" ] && [ -z "$(tail -c1 "$tmp")" ] && grep -q 'WINGMAN-SPEC:START' "$AGENTS"; then head -c "$(( $(wc -c < "$tmp") - 1 ))" "$tmp" > "$tmp.2" && mv "$tmp.2" "$tmp"; fi
  if cmp -s "$tmp" "$AGENTS"; then say "AGENTS.md   -> unchanged"; else cp "$tmp" "$AGENTS"; say "AGENTS.md   -> managed block updated"; fi
  rm -f "$tmp"
fi

# 4. config.yaml ---------------------------------------------------------------------------
# The real config (schema: wingman-spec + context/rules) lives in the OpenSpec root.
mkdir -p "$ROOT_DIR/openspec"
CFG="$ROOT_DIR/openspec/config.yaml"
SUGGESTED="$ROOT_DIR/openspec/config.wingman-spec.suggested.yaml"
WHERE="openspec/config.yaml"; [ -z "$STORE$SPECS" ] || WHERE="$CFG"

# Defaults detected from the code repo (a tool counts as a dependency when package.json lists it or a script runs it). Empty = not detected (the <fill in> placeholder stays and the verifier refuses).
pm() { if [ -f "$TARGET/pnpm-lock.yaml" ]; then echo pnpm; elif [ -f "$TARGET/yarn.lock" ]; then echo yarn; else echo npm; fi; }
pkg_has() { [ -f "$TARGET/package.json" ] && node -e '
  const p = require(process.argv[1]); const [kind, name] = process.argv.slice(2);
  const deps = { ...(p.dependencies || {}), ...(p.devDependencies || {}) };
  const scripts = Object.values(p.scripts || {}).join(" ");
  const ok = kind === "script" ? !!(p.scripts && p.scripts[name] && !/no test specified/.test(p.scripts[name]))
    : kind === "dep" ? name in deps || new RegExp("(^|[\\s&;|(])" + name.replace(/[^a-z0-9]/gi, "\\$&") + "(\\s|$)").test(scripts) : false;
  process.exit(ok ? 0 : 1);' "$TARGET/package.json" "$1" "$2" 2>/dev/null; }
detect_test_cmd() {
  if pkg_has script test; then echo "$(pm) test"
  elif [ -f "$TARGET/pytest.ini" ] || [ -f "$TARGET/conftest.py" ] || grep -qs '^\[tool\.pytest' "$TARGET/pyproject.toml" || grep -qs '^\[tool:pytest\]' "$TARGET/setup.cfg"; then echo "python3 -m pytest"
  elif ls "$TARGET"/tests/test_*.py >/dev/null 2>&1; then echo "python3 -m unittest discover -s tests -t ."
  elif [ -f "$TARGET/go.mod" ]; then echo "go test ./..."
  elif [ -f "$TARGET/Cargo.toml" ]; then echo "cargo test"
  elif grep -qs '^test:' "$TARGET/Makefile"; then echo "make test"
  fi
}
# Typecheck and lint commands, run by `verify-task.cjs check` after the tests (skipped when a task's Done when runs them).
detect_typecheck_cmd() {
  local p; p="$(pm)"; [ "$p" = npm ] && p="npm run"
  local s; for s in typecheck type-check typecheck:all check-types types tsc; do pkg_has script "$s" && { echo "$p $s"; return; }; done
  # --incremental: a check after a small edit re-reads only what changed (1.3 s instead of 3.0 s on 1,500 files); the build info stays in node_modules/.cache
  local inc="--incremental --tsBuildInfoFile node_modules/.cache/wingman-spec/tsc.tsbuildinfo"
  if pkg_has dep vue-tsc && [ -f "$TARGET/tsconfig.json" ]; then echo "npx vue-tsc --noEmit $inc"
  elif pkg_has dep typescript && [ -f "$TARGET/tsconfig.json" ]; then echo "npx tsc --noEmit $inc"
  elif [ -f "$TARGET/mypy.ini" ] || [ -f "$TARGET/.mypy.ini" ] || grep -qs '^\[tool\.mypy\]' "$TARGET/pyproject.toml" || grep -qs '^\[mypy\]' "$TARGET/setup.cfg"; then
    # mypy's own `files =` setting decides what to check; `mypy .` would override it (and check the tests too)
    if grep -qsE '^[[:space:]]*files[[:space:]]*=' "$TARGET/mypy.ini" "$TARGET/.mypy.ini" "$TARGET/pyproject.toml" "$TARGET/setup.cfg"; then echo "python3 -m mypy"; else echo "python3 -m mypy ."; fi
  elif [ -f "$TARGET/pyrightconfig.json" ] || grep -qs '^\[tool\.pyright\]' "$TARGET/pyproject.toml"; then echo "pyright"
  fi
}
detect_lint_cmd() {
  local p; p="$(pm)"; [ "$p" = npm ] && p="npm run"
  if pkg_has script lint; then echo "$p lint"
  elif pkg_has dep eslint && ls "$TARGET"/eslint.config.* "$TARGET"/.eslintrc* >/dev/null 2>&1; then echo "npx eslint --cache --cache-location node_modules/.cache/wingman-spec/eslint ."
  elif pkg_has dep @biomejs/biome && ls "$TARGET"/biome.json* >/dev/null 2>&1; then echo "npx biome lint ."
  elif [ -f "$TARGET/ruff.toml" ] || [ -f "$TARGET/.ruff.toml" ] || grep -qs '^\[tool\.ruff' "$TARGET/pyproject.toml"; then echo "ruff check ."
  elif [ -f "$TARGET/.flake8" ] || grep -qs '^\[flake8\]' "$TARGET/setup.cfg" "$TARGET/tox.ini"; then echo "python3 -m flake8"
  elif [ -f "$TARGET/.golangci.yml" ] || [ -f "$TARGET/.golangci.yaml" ]; then echo "golangci-lint run"
  fi
}
# probe_cmd <cmd>: runs a detected typecheck/lint command once on the current code (SPEC_INSTALL_PROBE=0 skips this).
# A command that is not runnable here, or already fails, would fail every task's check, so it is not configured:
# sets PROBED to the command when it passes (else empty) and PROBE_NOTE to the reason it was dropped.
probe_cmd() {
  PROBED=""; PROBE_NOTE=""; [ -n "$1" ] || return 0
  if [ "${SPEC_INSTALL_PROBE:-1}" = 0 ]; then PROBED="$1"; return 0; fi
  local out rc=0; out="$(cd "$TARGET" && timeout 300 bash -c "$1" 2>&1)" || rc=$?
  if [ "$rc" = 0 ]; then PROBED="$1"
  elif [ "$rc" = 127 ] || printf '%s' "$out" | grep -qE 'No module named|command not found|could not determine executable'; then PROBE_NOTE="detected \`$1\` but it is not installed here"
  else PROBE_NOTE="detected \`$1\` but it fails on the current code (exit $rc)"; fi
}
# prints "command|url" for a known web stack, "off" when the repo has no UI, nothing when it has a UI we cannot start.
detect_visual() {
  local p; p="$(pm)"; [ "$p" = npm ] && p="npm run"
  if pkg_has dep vite && pkg_has script build && pkg_has script preview; then echo "$p build && $p preview -- --port 4173 --strictPort --host 127.0.0.1|http://127.0.0.1:4173/"
  elif pkg_has dep next && pkg_has script build && pkg_has script start; then echo "$p build && $p start -- -p 3000 -H 127.0.0.1|http://127.0.0.1:3000/"
  elif pkg_has dep vite || pkg_has dep next || pkg_has dep react || pkg_has dep vue || pkg_has dep svelte || pkg_has dep @angular/core || pkg_has dep astro \
       || ls "$TARGET"/index.html "$TARGET"/src/*.vue "$TARGET"/src/*.tsx "$TARGET"/src/*.jsx >/dev/null 2>&1; then :
  else echo off
  fi
}
# report_visual_env LABEL: Playwright / Chromium / leftover-baselines notes for the code repo being installed.
report_visual_env() {
  local label="${1:-$WHERE}"
  if [ "$TARGET_VISUAL" != off ] && [ -f "$TARGET/package.json" ] && ! pkg_has dep playwright && ! pkg_has dep @playwright/test; then
    say "visual      -> Playwright is not a dependency: the visual check is SKIPPED with a warning until you run"
    say "               $(pm) add -D playwright axe-core && npx playwright install chromium"
  fi
  if [ "$TARGET_VISUAL" != off ]; then  # where is Chromium? Same search as visual-check.cjs findChromium (it launches what it finds)
    pwb="$(node -e '
      const fs = require("fs"), path = require("path"), os = require("os"), t = process.argv[1]; const c = [];
      const e = process.env.PLAYWRIGHT_BROWSERS_PATH; if (e && e !== "0") c.push([e, "PLAYWRIGHT_BROWSERS_PATH"]);
      c.push([path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "ms-playwright"), "default cache"], [path.join(os.homedir(), "Library/Caches/ms-playwright"), "default cache"]);
      if (process.env.LOCALAPPDATA) c.push([path.join(process.env.LOCALAPPDATA, "ms-playwright"), "default cache"]);
      const starts = [t]; for (const n of ["playwright", "@playwright/test", "playwright-core"]) { try { starts.push(path.dirname(fs.realpathSync(require.resolve(n, { paths: [t] })))); break; } catch (x) { /* next */ } }
      for (let d of starts) for (let k = 0; k < 8; k++) { c.push([path.join(d, "ms-playwright"), "found"], [path.join(d, "node_modules/playwright-core/.local-browsers"), "found"]); const u = path.dirname(d); if (u === d) break; d = u; }
      const hit = c.find(([d]) => { try { return fs.readdirSync(d).some((x) => /^chromium/.test(x)); } catch (x) { return false; } });
      if (hit) console.log(hit[1] + "|" + hit[0]);' "$TARGET" 2>/dev/null || true)"
    case "$pwb" in
      found\|*) say "visual      -> Chromium found in ${pwb#*|} (not where Playwright looks by default; the check uses it"
                say "               automatically; set visual.browsers_path or PLAYWRIGHT_BROWSERS_PATH to make it explicit)" ;;
      ?*) say "visual      -> Chromium found in ${pwb#*|} (${pwb%%|*})" ;;
      *) say "visual      -> no Playwright Chromium found (PLAYWRIGHT_BROWSERS_PATH, the default cache, next to the Playwright"
         say "               install): run npx playwright install chromium, or set visual.browsers_path in $label" ;;
    esac
  fi
}
ksay() { [ -n "${QUIET:-}" ] || say "$@"; }
# fill_config FILE: replace the placeholders the template ships with the detected defaults.
# shellcheck disable=SC2016  # the node -e programs are single-quoted on purpose
fill_config() {
  local f="$1" tc vis
  if [ -n "$TARGET_TEST_CMD" ]; then tc="$TARGET_TEST_CMD"; node -e '
    const fs = require("fs"), [f, v] = process.argv.slice(1);
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("- Test command: <fill in>", "- Test command: `" + v + "`"));' "$f" "$tc"
    ksay "test command -> detected \`$tc\` (edit '- Test command:' in $WHERE if wrong)"
  else
    ksay "test command -> NOT detected: set '- Test command:' in $WHERE (the verifier refuses to apply until it is set, or 'none')"
  fi
  local k v n
  for k in Typecheck Lint; do
    if [ "$k" = Typecheck ]; then v="$TARGET_TYPECHECK_CMD"; else v="$TARGET_LINT_CMD"; fi
    node -e '
      const fs = require("fs"), [f, k, v] = process.argv.slice(1); let s = fs.readFileSync(f, "utf8");
      s = s.replace(new RegExp("^(\\s*- " + k + " command:) <fill in>.*$", "m"), (m, a) => a + " " + (v ? "`" + v + "`" : "none"));
      fs.writeFileSync(f, s);' "$f" "$k" "$v"
    if [ -n "$v" ]; then ksay "$(printf '%-12s' "$(echo "$k" | tr '[:upper:]' '[:lower:]')") -> detected \`$v\` (runs in every check; edit '- $k command:' in $WHERE)"
    else
      n="$TYPECHECK_NOTE"; [ "$k" = Typecheck ] || n="$LINT_NOTE"
      ksay "$(printf '%-12s' "$(echo "$k" | tr '[:upper:]' '[:lower:]')") -> ${n:-none detected}: '- $k command: none' in $WHERE (set a passing one to run it in every check)"
    fi
  done
  vis="$TARGET_VISUAL"
  case "$vis" in
    off) node -e '
      const fs = require("fs"), f = process.argv[1];
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^visual:\n(?:[ \t]+.*\n)+/m, "visual: off                   # no UI detected; replace with command:/url: when the project gets one\n"));' "$f"
         ksay "visual      -> off (no UI detected in the code repo)" ;;
    "") ksay "visual      -> UI detected but not how to start it: set visual.command and visual.url in $WHERE" ;;
    *) node -e '
      const fs = require("fs"), [f, c, u] = process.argv.slice(1); let s = fs.readFileSync(f, "utf8");
      s = s.replace(/^(  command: )<fill in>( *#.*)?$/m, (m, a) => a + JSON.stringify(c)).replace(/^(  url: )<fill in>( *#.*)?$/m, (m, a) => a + u);
      fs.writeFileSync(f, s);' "$f" "${vis%%|*}" "${vis#*|}"
       ksay "visual      -> detected \`${vis%%|*}\` at ${vis#*|}" ;;
  esac
  [ -n "${QUIET:-}" ] || report_visual_env
}
# write_overrides FILE: workspace layouts (--store/--specs). Several code repos share ONE root config, so the commands
# detected from THIS repo go into this repo's own pointer file (openspec/config.yaml with `store:`, or
# openspec/workspace.yaml with `specs:`), under `verify: |` plus a `visual:` block. verify-task.cjs reads them from
# there before the root's, key by key. A key that is already in the file is never touched (user edits win).
# shellcheck disable=SC2016  # the node -e program is single-quoted on purpose
write_overrides() {
  local f="$1" st line key status k n
  command -v node >/dev/null 2>&1 || { say "commands    -> skipped (needs node); add '- Test command:' etc. to $f by hand"; return; }
  st="$(node -e '
    const fs = require("fs"); const [f, tc, ty, li, vis] = process.argv.slice(1);
    let s = fs.readFileSync(f, "utf8"); if (s && !s.endsWith("\n")) s += "\n";
    const has = (l) => new RegExp("^\\s*-?\\s*" + l + ":", "mi").test(s);
    const out = []; const add = [];
    for (const [l, v, k] of [["Test command", tc || "<fill in>", "test"], ["Typecheck command", ty || "none", "typecheck"], ["Lint command", li || "none", "lint"]]) {
      if (has(l)) { out.push(k + ":kept"); continue; }
      add.push("  - " + l + ": " + (v === "<fill in>" || v === "none" ? v : "`" + v + "`"));
      out.push(k + ":" + (v === "<fill in>" ? "placeholder" : v === "none" ? "none" : "written"));
    }
    if (add.length) {
      const m = s.match(/^verify:[ \t]*\|[ \t]*\n/m);
      if (m) { const i = m.index + m[0].length; s = s.slice(0, i) + add.join("\n") + "\n" + s.slice(i); }
      else if (/^verify:/m.test(s)) { out.length = 0; out.push("test:conflict"); }
      else s += "\n# Commands the verifier runs for THIS code repo; they override the shared specs config key by key.\nverify: |\n" + add.join("\n") + "\n";
    }
    if (/^visual:/m.test(s)) out.push("visual:kept");
    else if (vis === "off") { s += "\nvisual: off                   # no UI detected; replace with command:/url: when the project gets one\n"; out.push("visual:off"); }
    else if (vis === "") { s += "\nvisual:                       # UI detected but not how to start it\n  command: <fill in>\n  url: <fill in>\n"; out.push("visual:placeholder"); }
    else { const i = vis.indexOf("|"); s += "\nvisual:\n  command: " + JSON.stringify(vis.slice(0, i)) + "\n  url: " + vis.slice(i + 1) + "\n"; out.push("visual:written"); }
    fs.writeFileSync(f, s); console.log(out.join("\n"));' "$f" "$TARGET_TEST_CMD" "$TARGET_TYPECHECK_CMD" "$TARGET_LINT_CMD" "$TARGET_VISUAL" 2>/dev/null)" || st=""
  [ -n "$st" ] || { say "commands    -> could not update $f; add '- Test command:' etc. by hand"; return; }
  while IFS=: read -r key status; do
    case "$key:$status" in
      test:written) say "test command -> detected \`$TARGET_TEST_CMD\`, written to $f (this repo only; edit if wrong)" ;;
      test:placeholder) say "test command -> NOT detected: '- Test command: <fill in>' written to $f; set it (or 'none'): the verifier refuses until then" ;;
      test:conflict) say "commands    -> $f has a 'verify:' key that is not a block (verify: |); NOT modified. Add the command lines to it by hand." ;;
      typecheck:written|lint:written) if [ "$key" = typecheck ]; then k="$TARGET_TYPECHECK_CMD"; else k="$TARGET_LINT_CMD"; fi
        say "$(printf '%-12s' "$key") -> detected \`$k\`, written to $f (runs in every check)" ;;
      typecheck:none|lint:none) if [ "$key" = typecheck ]; then n="$TYPECHECK_NOTE"; else n="$LINT_NOTE"; fi
        say "$(printf '%-12s' "$key") -> ${n:-none detected}: 'none' written to $f (set a passing command to run it in every check)" ;;
      visual:written) say "visual      -> detected \`${TARGET_VISUAL%%|*}\` at ${TARGET_VISUAL#*|}, written to $f" ;;
      visual:off) say "visual      -> off (no UI detected in this repo), written to $f" ;;
      visual:placeholder) say "visual      -> UI detected but not how to start it: set visual.command and visual.url in $f" ;;
      *:kept) say "$(printf '%-12s' "$key") -> already set in $f (left untouched)" ;;
    esac
  done <<EOF2
$st
EOF2
  report_visual_env "$f"
}
TARGET_TEST_CMD=""; TARGET_VISUAL=""; TARGET_TYPECHECK_CMD=""; TARGET_LINT_CMD=""
if command -v node >/dev/null 2>&1; then TARGET_TEST_CMD="$(detect_test_cmd)"; TARGET_VISUAL="$(detect_visual)"; fi
TYPECHECK_NOTE=""; LINT_NOTE=""
if command -v node >/dev/null 2>&1; then
  probe_cmd "$(detect_typecheck_cmd)"; TARGET_TYPECHECK_CMD="$PROBED"; TYPECHECK_NOTE="$PROBE_NOTE"
  probe_cmd "$(detect_lint_cmd)"; TARGET_LINT_CMD="$PROBED"; LINT_NOTE="$PROBE_NOTE"
fi

# Workspace layout (--store/--specs): the root config is shared by every code repo, so it only gets defaults while it has
# none (taken from the first repo installed). The commands of each repo go into that repo's own pointer file below.
WS=""; [ -z "$STORE$SPECS" ] || WS=1
if [ ! -f "$CFG" ]; then
  cp "$PKG/project-template/config.yaml.tmpl" "$CFG"; QUIET="$WS" fill_config "$CFG"
  say "config.yaml -> created in $WHERE (fill in the 'Project facts' in context)"
  [ -z "$WS" ] || say "               its test/typecheck/lint/visual lines are shared defaults (detected from this repo); every repo keeps its own in its pointer file"
elif grep -qE "^schema:[[:space:]]*['\"]?wingman-spec['\"]?[[:space:]]*(#.*)?$" "$CFG"; then
  say "config.yaml -> already uses wingman-spec (left untouched)"
  grep -qE "^traceability:" "$CFG" || say "               no 'traceability:' key: the Why check and code anchors are OFF here. Add 'traceability: warn' (findings as warnings) or 'on' (enforced); see $PKG/project-template/config.yaml.tmpl. Sync before archive is enforced either way."
  for k in Typecheck Lint; do
    [ -z "$WS" ] || continue
    if [ "$k" = Typecheck ]; then v="$TARGET_TYPECHECK_CMD"; else v="$TARGET_LINT_CMD"; fi
    grep -qE "^[[:space:]]*-?[[:space:]]*$k command:" "$CFG" && continue
    if [ -n "$v" ]; then say "               add '- $k command: \`$v\`' to its context (detected; check runs it after the tests)"
    else n="$TYPECHECK_NOTE"; [ "$k" = Typecheck ] || n="$LINT_NOTE"; say "               add '- $k command: none' to its context${n:+ ($n)} (or a passing command, to run it in every check)"; fi
  done
elif [ "$(grep -vE '^[[:space:]]*(#|$)' "$CFG")" = "$(grep -E '^schema:' "$CFG" | head -n1)" ] && [ "$(grep -cE '^schema:' "$CFG")" = 1 ] \
     && ! grep -E '^[[:space:]]*#' "$CFG" | grep -vE '^#([[:space:]]*$| (Project context|Per-artifact rules|Per-operation guidance|Add |Include |Keep |Example:|This is separate)|   )' | grep -q .; then
  # Only a `schema:` line plus the stock comments of `openspec init` / `store setup`: the untouched default. Nothing to lose.
  # A comment of the user's own makes it a human file: it is never rewritten (the suggestion file below is written instead).
  cp "$PKG/project-template/config.yaml.tmpl" "$CFG"; QUIET="$WS" fill_config "$CFG"
  say "config.yaml -> default replaced in $WHERE (fill in the 'Project facts' in context)"
  [ -z "$WS" ] || say "               its test/typecheck/lint/visual lines are shared defaults (detected from this repo); every repo keeps its own in its pointer file"
else
  cp "$PKG/project-template/config.yaml.tmpl" "$SUGGESTED"; QUIET="$WS" fill_config "$SUGGESTED"
  say "config.yaml -> exists in $WHERE; NOT modified. Merge $SUGGESTED into it"
  say "               (set 'schema: wingman-spec' and add its context/rules/operations), then delete the suggestion."
fi

# Workspace layout: the code repo gets a config-only openspec/config.yaml that points at the store.
if [ -n "$STORE" ]; then
  mkdir -p "$TARGET/openspec"
  PCFG="$TARGET/openspec/config.yaml"
  if [ ! -f "$PCFG" ]; then
    printf '# OpenSpec workspace pointer: specs, changes, the schema and ADRs live in the store below.\n# Keep this directory config-only (never create openspec/specs or openspec/changes here).\nstore: %s\n' "$STORE" > "$PCFG"
    say "pointer     -> openspec/config.yaml (store: $STORE)"
    add_remote_hint "$PCFG" store_remote store "$(detect_remote "$ROOT_DIR")"
    write_overrides "$PCFG"
  elif [ "$(yaml_value store "$PCFG")" = "$STORE" ]; then
    say "pointer     -> already points at store $STORE (left untouched)"
    add_remote_hint "$PCFG" store_remote store "$(detect_remote "$ROOT_DIR")"
    write_overrides "$PCFG"
  elif grep -qE '^store:' "$PCFG"; then
    say "pointer     -> $PCFG points at a different store; NOT modified. Change it to 'store: $STORE' by hand."
  else
    printf 'store: %s\n' "$STORE" > "$TARGET/openspec/config.store.suggested.yaml"
    say "pointer     -> $PCFG exists; NOT modified. Add the line from openspec/config.store.suggested.yaml, then delete it."
  fi
fi

# Workspace layout with a separate specs repo: the code repo records where it is (relative path).
if [ -n "$SPECS" ]; then
  mkdir -p "$TARGET/openspec"
  REL="$ROOT_DIR"
  command -v node >/dev/null 2>&1 && REL="$(node -e 'console.log(require("path").relative(process.argv[1], process.argv[2]) || ".")' "$TARGET" "$ROOT_DIR")"
  LINK="$TARGET/openspec/workspace.yaml"
  if [ ! -f "$LINK" ]; then
    printf '# Links this code repo to the separate repository that holds its OpenSpec files\n# (config, schema, specs, changes, ADRs). Relative to this repo. Open both folders in one VS Code/Cursor workspace.\nspecs: %s\n' "$REL" > "$LINK"
    say "link        -> openspec/workspace.yaml (specs: $REL)"
    add_remote_hint "$LINK" specs_remote specs "$(detect_remote "$ROOT_DIR")"
    write_overrides "$LINK"
  elif [ "$(yaml_value specs "$LINK")" = "$REL" ]; then
    say "link        -> already points at $REL (left untouched)"
    add_remote_hint "$LINK" specs_remote specs "$(detect_remote "$ROOT_DIR")"
    write_overrides "$LINK"
  else
    say "link        -> $LINK already exists with a different 'specs:' value; NOT modified. Set it to 'specs: $REL' by hand."
  fi
fi

# Optional .code-workspace that opens the code repo and the specs repo together.
if [ -n "$WORKSPACE_FILE" ]; then
  mkdir -p "$(dirname "$WORKSPACE_FILE")"
  WORKSPACE_FILE="$(cd "$(dirname "$WORKSPACE_FILE")" && pwd)/$(basename "$WORKSPACE_FILE")"
  if [ -f "$WORKSPACE_FILE" ]; then
    # Several code repos share one workspace file: add this repo's folder (and the specs folder) when they are missing.
    # Only plain JSON is rewritten; a file with comments or another shape is left untouched.
    wsres="$(command -v node >/dev/null 2>&1 && node -e '
      const path = require("path"), fs = require("fs");
      const [file, code, specs] = process.argv.slice(1);
      const rel = (p) => path.relative(path.dirname(file), p) || ".";
      let j; try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.log("manual"); process.exit(0); }
      if (!j || !Array.isArray(j.folders)) { console.log("manual"); process.exit(0); }
      const have = (p) => j.folders.some((f) => f && typeof f.path === "string" && path.resolve(path.dirname(file), f.path) === path.resolve(p));
      const add = [];
      if (!have(code)) add.push({ name: "code: " + path.basename(code), path: rel(code) });
      if (!have(specs)) add.push({ name: "specs: " + path.basename(specs), path: rel(specs) });
      // json-patch.cjs rewrites the file only when it is in the canonical layout; any other layout is left as it is
      if (add.length && require(process.argv[4]).patch(file, (x) => { x.folders.push(...add); }) === "manual") { console.log("manual"); process.exit(0); }
      console.log(add.length ? "added " + add.map((f) => f.name).join(", ") : "same");' "$WORKSPACE_FILE" "$TARGET" "$ROOT_DIR" "$PKG/scripts/json-patch.cjs" 2>/dev/null || true)"
    case "$wsres" in
      added*) say "workspace   -> $WORKSPACE_FILE exists; added folder ${wsres#added }" ;;
      same) say "workspace   -> $WORKSPACE_FILE already lists the folders (left untouched)" ;;
      *) say "workspace   -> $WORKSPACE_FILE exists (left untouched; add the folder $TARGET to it by hand)" ;;
    esac
  elif command -v node >/dev/null 2>&1; then
    node -e '
      const path = require("path"), fs = require("fs");
      const [file, code, specs] = process.argv.slice(1);
      const rel = (p) => path.relative(path.dirname(file), p) || ".";
      const j = { folders: [
        { name: "code: " + path.basename(code), path: rel(code) },
        { name: "specs: " + path.basename(specs), path: rel(specs) },
      ] };
      fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");' "$WORKSPACE_FILE" "$TARGET" "$ROOT_DIR"
    say "workspace   -> $WORKSPACE_FILE (code + specs folders)"
  else
    say "workspace   -> skipped (needs node to write $WORKSPACE_FILE)"
  fi
fi

# 5. per-harness entry points, subagent, skills and guard hook ----------------------------------
install_skills() {
  local dest_root="$1" skill name dest
  mkdir -p "$TARGET/$dest_root"
  for skill in "$PKG"/skills/*/; do
    [ -f "$skill/SKILL.md" ] || continue
    name="$(basename "$skill")"
    dest="$TARGET/$dest_root/$name"
    rm -rf "$dest"
    cp -R "$skill" "$dest"
    # Authoring-only files of a vendored skill (its creation log and pressure-test scenarios) are not instructions: do not install them.
    rm -f "$dest"/CREATION-LOG.md "$dest"/test-academic.md "$dest"/test-pressure-*.md
    say "skill $name -> installed ($dest_root)"
  done
}

# Render one harness from the single source, then copy over the target (always overwritten).
install_generated() {
  local h="$1" out rel dest n=0
  out="$(mktemp -d)"
  "$PKG/scripts/render-harness.sh" "$h" "$out" > "$out.list"
  while IFS= read -r rel; do
    dest="$TARGET/$rel"; mkdir -p "$(dirname "$dest")"
    cp "$out/$rel" "$dest"; n=$((n + 1))
  done < "$out.list"
  rm -rf "$out" "$out.list"
  say "$h: $n generated files"
}

# merge_hook FILE NODE_SNIPPET LABEL: create or merge a JSON hook config with node; never clobber on failure.
merge_hook() {
  local file="$1" js="$2" label="$3"
  mkdir -p "$(dirname "$file")"
  if [ -f "$file" ] && grep -q 'spec-guard.cjs' "$file"; then say "hook        -> already registered in $label"; return; fi
  local res=""
  if command -v node >/dev/null 2>&1; then res="$(node "$PKG/scripts/json-patch.cjs" "$file" "$js" 2>/dev/null)" || res=""; fi
  case "$res" in
    written|created) say "hook        -> registered in $label" ;;
    manual) say "hook        -> $label has its own layout (comments, compact or unusual formatting): NOT modified. Register node spec-guard.cjs in it by hand" ;;
    *) say "hook        -> $label could not be written or merged (needs node and valid JSON); register spec-guard.cjs by hand" ;;
  esac
}

install_guard() {
  local dir="$1"
  mkdir -p "$TARGET/$dir/hooks"
  cp "$PKG/project-template/hooks/spec-guard.cjs" "$TARGET/$dir/hooks/spec-guard.cjs"
}

if has_harness cursor; then
  install_skills ".cursor/skills"
  install_generated cursor
  install_guard .cursor
  merge_hook "$TARGET/.cursor/hooks.json" 'j.version = j.version || 1; (j.hooks.beforeSubmitPrompt = j.hooks.beforeSubmitPrompt || []).push({ command: "node .cursor/hooks/spec-guard.cjs" });' ".cursor/hooks.json (beforeSubmitPrompt)"
fi

if has_harness claude; then
  install_skills ".claude/skills"
  install_generated claude
  install_guard .claude
  # shellcheck disable=SC2016 # $CLAUDE_PROJECT_DIR is expanded by Claude Code, not here
  merge_hook "$TARGET/.claude/settings.json" '(j.hooks.UserPromptSubmit = j.hooks.UserPromptSubmit || []).push({ hooks: [{ type: "command", command: "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/spec-guard.cjs\" --format claude" }] });' ".claude/settings.json (UserPromptSubmit)"
  # Claude Code reads CLAUDE.md, not AGENTS.md: import it (one managed line).
  if [ ! -f "$TARGET/CLAUDE.md" ]; then
    printf '@AGENTS.md\n' > "$TARGET/CLAUDE.md"; say "CLAUDE.md   -> created (imports AGENTS.md)"
  elif grep -qxF '@AGENTS.md' "$TARGET/CLAUDE.md"; then
    say "CLAUDE.md   -> already imports AGENTS.md"
  else
    last="$(tail -c1 "$TARGET/CLAUDE.md")"
    { [ -z "$last" ] || echo; echo; echo '@AGENTS.md'; } >> "$TARGET/CLAUDE.md"; say "CLAUDE.md   -> import of AGENTS.md appended"
  fi
fi

if has_harness codex; then
  install_skills ".agents/skills"
  install_generated codex
  install_guard .codex
  # shellcheck disable=SC2016 # $(git rev-parse ...) is expanded by Codex when the hook runs
  merge_hook "$TARGET/.codex/hooks.json" '(j.hooks.UserPromptSubmit = j.hooks.UserPromptSubmit || []).push({ hooks: [{ type: "command", command: "node \"$(git rev-parse --show-toplevel)/.codex/hooks/spec-guard.cjs\" --format codex" }] });' ".codex/hooks.json (UserPromptSubmit; trust it with /hooks in Codex)"
fi

if [ -n "$STORE$SPECS" ]; then
WS_PTR="openspec/config.yaml"
if [ -n "$STORE" ]; then
  WS_DESC="OpenSpec workspace '$STORE' at $ROOT_DIR"; WS_CHECK="cd \"$TARGET\" && openspec doctor      (confirms the store pointer resolves)"
else
  WS_DESC="specs repo at $ROOT_DIR"; WS_PTR="openspec/workspace.yaml"; WS_CHECK="open $TARGET and $ROOT_DIR together as one multi-root workspace${WORKSPACE_FILE:+ ($WORKSPACE_FILE)}"
fi
cat <<EOF

Done (workspace layout: code in $TARGET, $WS_DESC). Next steps:
  1. $WS_CHECK
  2. Edit 'Project facts' in the specs repo's openspec/config.yaml. This repo's own test/typecheck/lint commands and
     'visual:' live in ${WS_PTR:-its pointer file} (they win over the specs repo's, key by key); then run
     node openspec/scripts/verify-task.cjs doctor   (shows the file each command comes from, and what is missing).
     Several git repos? Run ./install.sh once for each of them with the same --store/--specs.
  3. Plan:            /spec-explore (grills you), then /spec-propose <change>
  4. Implement:       /spec-apply <change>   (one subagent per task, checked by openspec/scripts/verify-task.cjs)
  5. Fix (optional):  /spec-fix [change] [findings]   (QA / developer tweaks; classify, then spec + TDD)
  6. Archive:         /spec-archive <change>   (syncs first: specs, ADRs; they land in the specs repo)
                      /spec-sync <change> only to inspect or fix a sync problem
  Later drift?       /spec-garden   (aligns specs, code anchors and tests: fix each gap or accept it)
  Existing codebase? /spec-adopt [scope]   (baseline specs + ADRs, run once before the first change)
  New product?       /spec-green-start   (no code yet: writes the whole spec from client requirements; run it again after every pause)
  To plan from inside the specs repo too, run ./install.sh "$ROOT_DIR" (commands, skills and AGENTS.md there).
EOF
else
cat <<EOF

Done. Next steps:
  1. cd "$TARGET" && openspec schema validate wingman-spec
  2. Edit openspec/config.yaml 'Project facts' (stack, test command) and 'visual:';
     node openspec/scripts/verify-task.cjs doctor   reports what is still missing.
  3. Plan:            /spec-explore (grills you), then /spec-propose <change>
  4. Implement:       /spec-apply <change>   (one subagent per task, checked by openspec/scripts/verify-task.cjs)
  5. Fix (optional):  /spec-fix [change] [findings]   (QA / developer tweaks; classify, then spec + TDD)
  6. Archive:         /spec-archive <change>   (syncs first: specs, then ADRs)
                      /spec-sync <change> only to inspect or fix a sync problem
  Later drift?       /spec-garden   (aligns specs, code anchors and tests: fix each gap or accept it)
  Existing codebase? /spec-adopt [scope]   (baseline specs + ADRs, run once before the first change)
  New product?       /spec-green-start   (no code yet: writes the whole spec from client requirements; run it again after every pause)
  Codex: the commands are skills; type \$spec-apply <change> etc. Harnesses installed:$HARNESS_LIST
  Several git repos in one workspace, or specs in a separate repo? Use a registered OpenSpec store (one for all repos):
    openspec store setup <id> --path <dir>   then   ./install.sh <code-repo> --store <id> --harness all   per repo
  (or --specs <specs-repo> without a registry; see README "Two layouts")
EOF
fi
