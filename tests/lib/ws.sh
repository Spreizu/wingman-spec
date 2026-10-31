# shellcheck shell=bash
# Shared setup for the shell suites: they run against the wingman-spec binary.
# WINGMAN_SPEC_BIN picks the binary (default: `wingman-spec` on PATH; tests/run.sh builds one).
WS="${WINGMAN_SPEC_BIN:-$(command -v wingman-spec || true)}"
[ -x "$WS" ] || { echo "wingman-spec binary not found: set WINGMAN_SPEC_BIN or put it on PATH (tests/run.sh builds it)" >&2; exit 2; }
export WS
# The visual helper of this checkout (a release binary writes the one embedded in it to .wingman-spec/bin).
if [ -z "${WINGMAN_VISUAL:-}" ] && [ -f "$(dirname "${BASH_SOURCE[0]}")/../../visual/wingman-visual.cjs" ]; then
  WINGMAN_VISUAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../visual" && pwd)/wingman-visual.cjs"; export WINGMAN_VISUAL
fi
# The project's settings file and run folder, relative to the code root.
WCFG=.wingman-spec/wingman-spec.yaml
WRUNS=.wingman-spec/runs
# ws_init [dir]: a git repo with the Wingman Spec skeleton. The commands stay <fill in> until ws_commands sets them.
# The suites check one dispatch at a time (parallel: 1); tests/parallel-waves.sh turns waves back on.
ws_init() {
  local d="${1:-.}"; mkdir -p "$d"
  ( cd "$d" && { [ -d .git ] || git init -q; } && "$WS" init --no-detect >/dev/null && ws_set parallel 1 ) || { echo "wingman-spec init failed in $d" >&2; exit 1; }
}
# ws_set <key> <value> [file]: set a top-level key (`visual off` replaces the whole visual block).
ws_set() {
  local f="${3:-$WCFG}"
  awk -v k="$1" -v v="$2" '
    BEGIN { done = 0 }
    skip && /^[^ #]/ { skip = 0 }
    skip { next }
    index($0, k ":") == 1 || index($0, "# " k ":") == 1 {
      print k ": " v; done = 1
      if (k == "visual" || $0 ~ /^[a-z_]+:[ \t]*$/) skip = 1
      next }
    { print }
    END { if (!done) print k ": " v }' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
}
# ws_cmd <test|typecheck|lint|targeted|test_run|check_level> <value> [file]: set one commands.<key>.
ws_cmd() {
  local f="${3:-$WCFG}"
  awk -v k="$1" -v v="$2" '
    /^commands:/ { inc = 1; print; next }
    inc && /^[^ #]/ { if (!done) print "  " k ": " v; done = 1; inc = 0 }
    inc && (index($0, "  " k ":") == 1 || index($0, "  # " k ":") == 1) { print "  " k ": " v; done = 1; next }
    { print }
    END { if (inc && !done) print "  " k ": " v }' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
}
# ws_visual <key> <value> [file]: set visual.<key> (turns `visual: off` into a block first).
ws_visual() {
  local f="${3:-$WCFG}"
  if grep -q '^visual: off' "$f"; then sed -i.b 's/^visual: off.*$/visual:/' "$f" && rm -f "$f.b"; fi
  awk -v k="$1" -v v="$2" '
    /^visual:/ { inv = 1; print; next }
    inv && /^[^ #]/ { if (!done) print "  " k ": " v; done = 1; inv = 0 }
    inv && (index($0, "  " k ":") == 1 || index($0, "  # " k ":") == 1) { print "  " k ": " v; done = 1; next }
    { print }
    END { if (inv && !done) print "  " k ": " v }' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
}
# ws_project: ws_init plus test/typecheck/lint none, context filled in and visual off: the usual suite start.
ws_project() {
  ws_init "${1:-.}"
  ( cd "${1:-.}" && ws_cmd test none && ws_cmd typecheck none && ws_cmd lint none && ws_set visual off \
    && sed -i.b 's/^  <fill in>$/  Demo project for the suite./' "$WCFG" && rm -f "$WCFG.b" )
}
# ws_json <expr>: read JSON on stdin, print the value at a dotted path (a.b.0.c); empty when missing.
ws_json() { node -e 'let j=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const k of process.argv[1].split(".")){j=j==null?undefined:j[k]}console.log(j===undefined?"":typeof j==="object"?JSON.stringify(j):String(j))' "$1"; }

# ws_vcfg <visual lines>: the merged config (JSON) of a scratch project whose visual section has these lines; a config
# problem is printed instead (it names the key).
ws_vcfg() {
  local d; d="$(mktemp -d)"; mkdir -p "$d/.wingman-spec"
  printf 'visual:\n  command: x\n  url: http://127.0.0.1:1/\n%s' "$1" > "$d/.wingman-spec/wingman-spec.yaml"
  (cd "$d" && git init -q && "$WS" config --json 2>&1); rm -rf "$d"
}
