#!/usr/bin/env bash
# Marker placement check (openspec/scripts/placement.cjs): good files give no finding, bad files give each finding kind,
# in ts, js, py, go, java, vue and php. Needs only Node.
set -u
PKG="$(cd "$(dirname "$0")/.." && pwd)"
P=0; F=0
ok() { echo "  ok   $1"; P=$((P+1)); }
bad() { echo "  FAIL $1"; F=$((F+1)); }
expect() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
kinds() { node -e '
const { placementFindings } = require(process.argv[1]);
const s = require("fs").readFileSync(process.argv[2], "utf8");
console.log([...new Set(placementFindings(s, /\.test\./.test(process.argv[2])).map((f) => f.kind))].sort().join(" "));
' "$PKG/project-template/openspec/scripts/placement.cjs" "$1"; }
FIX="$PKG/tests/fixtures/placement"
echo "== placement: good fixtures give no finding"
for f in good.ts good.js good.py good.go Good.java good.vue good.php; do
  expect "$f: no finding" '[ -z "$(kinds $FIX/$f)" ]'
done
echo "== placement: bad fixtures give every kind (file-top, trailing, duplicate, detached)"
for f in bad.ts bad.js bad.py bad.go Bad.java bad.vue bad.php; do
  got="$(kinds $FIX/$f)"
  case "$f" in
    bad.vue) want="detached-marker duplicate-marker trailing-marker" ;;   # the template comment is attached to <script>
    *) want="detached-marker duplicate-marker file-top-marker trailing-marker" ;;
  esac
  expect "$f: $want" '[ "$got" = "$want" ]'
done
echo "== placement: edge cases"
t() { node -e '
const { placementFindings } = require(process.argv[1]);
console.log(placementFindings(process.argv[2].replace(/\\n/g, "\n"), process.argv[3] === "test").map((f) => f.kind + ":" + f.line).join(" "));
' "$PKG/project-template/openspec/scripts/placement.cjs" "$1" "${2:-src}"; }
expect "a test file may carry one marker at the top"       '[ -z "$(t "// @spec a/b\nimport x from \"y\";\nit(\"one\", () => {});\nit(\"two\", () => {});\n" test)" ]'
expect "the same marker in the doc comment and in another function is fine" '[ -z "$(t "/** @spec a/b */\nfunction one() {\n  return 1;\n}\n\n/** @spec a/b */\nfunction two() {\n  return 2;\n}\n")" ]'
expect "two requirements in one function, each marked once, are fine" '[ -z "$(t "function f() {\n  // @spec a/b\n  x();\n  // @spec a/c\n  y();\n}\n")" ]'
expect "a marker listing several keys is not a duplicate of itself" '[ -z "$(t "/** @spec a/b, a/c */\nfunction f() {}\n")" ]'
expect "the same key twice in one function is reported on the second line" '[ "$(t "function f() {\n  // @spec a/b\n  x();\n  // @spec a/b\n  y();\n}\n")" = "duplicate-marker:4" ]'
expect "an end-of-line marker is reported"                 '[ "$(t "function f() {\n  x(); // @spec a/b\n}\n")" = "trailing-marker:2" ]'
expect "a marker before a closing brace is detached"       '[ "$(t "function f() {\n  x();\n  // @spec a/b\n}\n")" = "detached-marker:3" ]'
expect "a marker followed by a decorator then the function is attached" '[ -z "$(t "# @spec a/b\n@decorator\ndef f():\n    pass\n")" ]'
echo
echo "placement: passed=$P failed=$F"
[ "$F" = 0 ]
