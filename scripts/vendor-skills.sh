#!/usr/bin/env bash
# vendor-skills.sh - fetch (or verify) the upstream skills bundled in skills/.
#
# Copies skill folders verbatim from upstream at pinned commit SHAs recorded in
# skills/vendor.lock, and regenerates skills/VENDORED.md.
#
# Usage:
#   scripts/vendor-skills.sh                 fetch at the SHAs in vendor.lock
#   scripts/vendor-skills.sh --update        re-pin to upstream `main` HEAD, then fetch
#   scripts/vendor-skills.sh --verify        check skills/ byte-matches upstream at the pins
#
# Requires: curl, python3. Unauthenticated GitHub API (60 req/h) is sufficient.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS="$REPO_ROOT/skills"
LOCK="$SKILLS/vendor.lock"

# name|upstream repo|upstream path
SOURCES="
test-driven-development|obra/superpowers|skills/test-driven-development
systematic-debugging|obra/superpowers|skills/systematic-debugging
requesting-code-review|obra/superpowers|skills/requesting-code-review
verification-before-completion|obra/superpowers|skills/verification-before-completion
grilling|mattpocock/skills|skills/productivity/grilling
ponytail|DietrichGebert/ponytail|skills/ponytail
ponytail-review|DietrichGebert/ponytail|skills/ponytail-review
"

MODE=fetch
case "${1:-}" in
  "") ;;
  --update) MODE=update ;;
  --verify) MODE=verify ;;
  -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "unknown option $1" >&2; exit 2 ;;
esac

mkdir -p "$SKILLS"

lock_get() { [ -f "$LOCK" ] && awk -F= -v k="$1" '$1==k {print $2}' "$LOCK" || true; }

head_sha() {
  curl -fsS "https://api.github.com/repos/$1/commits/main" |
    python3 -c 'import sys,json; print(json.load(sys.stdin)["sha"])'
}

repo_key() { echo "$1" | tr '/' '_'; }

# files_at REPO SHA PREFIX -> blob paths under PREFIX/
files_at() {
  curl -fsS "https://api.github.com/repos/$1/git/trees/$2?recursive=1" |
    python3 -c '
import sys, json
prefix = sys.argv[1].rstrip("/") + "/"
for e in json.load(sys.stdin)["tree"]:
    if e["type"] == "blob" and e["path"].startswith(prefix):
        print(e["path"])' "$3"
}

# fetch_skill REPO SHA UPSTREAM_PATH DEST_DIR
fetch_skill() {
  local repo="$1" sha="$2" up="$3" dest="$4" p rel
  rm -rf "$dest"; mkdir -p "$dest"
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    rel="${p#"$up"/}"
    mkdir -p "$dest/$(dirname "$rel")"
    curl -fsS "https://raw.githubusercontent.com/$repo/$sha/$p" -o "$dest/$rel"
    case "$rel" in *.sh) chmod +x "$dest/$rel" ;; esac
  done < <(files_at "$repo" "$sha" "$up")
  [ -f "$dest/SKILL.md" ] || { echo "no SKILL.md fetched for $repo:$up@$sha" >&2; exit 1; }
}

# Resolve pins per repo.
REPOS="$(echo "$SOURCES" | awk -F'|' 'NF>1 {print $2}' | sort -u)"
PIN_LINES=""
for repo in $REPOS; do
  key="$(repo_key "$repo")"
  sha="$(lock_get "$key")"
  if [ "$MODE" = update ] || [ -z "$sha" ]; then sha="$(head_sha "$repo")"; fi
  PIN_LINES="$PIN_LINES$key=$sha
"
done

pin_for() { echo "$PIN_LINES" | awk -F= -v k="$(repo_key "$1")" '$1==k {print $2}'; }

if [ "$MODE" = verify ]; then
  tmp="$(mktemp -d)"; rc=0
  while IFS='|' read -r name repo up; do
    [ -n "$name" ] || continue
    sha="$(pin_for "$repo")"
    fetch_skill "$repo" "$sha" "$up" "$tmp/$name"
    if diff -r "$tmp/$name" "$SKILLS/$name" >/dev/null 2>&1; then echo "ok       $name @ ${sha:0:7}"
    else echo "MISMATCH $name @ ${sha:0:7}" >&2; rc=1; fi
  done <<EOF
$SOURCES
EOF
  rm -rf "$tmp"; exit $rc
fi

printf '%s' "$PIN_LINES" > "$LOCK"

while IFS='|' read -r name repo up; do
  [ -n "$name" ] || continue
  sha="$(pin_for "$repo")"
  echo "fetching $name  ($repo@${sha:0:7}:$up)"
  fetch_skill "$repo" "$sha" "$up" "$SKILLS/$name"
done <<EOF
$SOURCES
EOF

{
  echo "# Vendored skills"
  echo
  echo "Verbatim, unmodified copies of third-party skills, pinned to upstream commits (see \`vendor.lock\`)."
  echo "Upstreams are MIT licensed (obra/superpowers, mattpocock/skills, DietrichGebert/ponytail)."
  echo "Refresh with \`scripts/vendor-skills.sh --update\`; check integrity with \`scripts/vendor-skills.sh --verify\`."
  echo
  echo "| Skill | Upstream | Path | Commit | License |"
  echo "|-------|----------|------|--------|---------|"
  while IFS='|' read -r name repo up; do
    [ -n "$name" ] || continue
    sha="$(pin_for "$repo")"
    echo "| \`$name\` | [$repo](https://github.com/$repo) | \`$up\` | \`${sha:0:12}\` | MIT |"
  done <<EOF
$SOURCES
EOF
  echo
  echo "Notes:"
  echo "- \`grilling\` is used directly; upstream's \`grill-me\` is only a one-line stub that calls it, so it is not bundled."
  echo "- \`verification-before-completion\` is bundled because \`systematic-debugging\` references it."
  echo "- Only \`ponytail\` and \`ponytail-review\` are bundled from DietrichGebert/ponytail (not audit/debt/gain/help or Cursor hooks)."
  echo "- Upstream text such as the \`superpowers:\` prefix is intentionally left untouched."
} > "$SKILLS/VENDORED.md"

echo "done. Pins written to skills/vendor.lock"
