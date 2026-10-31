#!/usr/bin/env bash
# Packages the VS Code extension: one vsix per platform with the wingman-spec binary in bin/ (the extension always runs
# its bundled CLI, so there is no universal vsix).
# usage: scripts/package-vsix.sh [target ...]   (default: every target below)
# Output: vscode-extension/dist/wingman-spec-<target>-<version>.vsix.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$REPO/vscode-extension"
ALL="linux-x64 linux-arm64 darwin-x64 darwin-arm64 win32-x64 win32-arm64"
TARGETS="${*:-$ALL}"
VERSION="$(node -p "require('$EXT/package.json').version")"
COMMIT="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
VSCE="${VSCE:-npx --no-install vsce}"

goos() { case "$1" in linux-*) echo linux;; darwin-*) echo darwin;; win32-*) echo windows;; *) return 1;; esac; }
goarch() { case "$1" in *-x64) echo amd64;; *-arm64) echo arm64;; *) return 1;; esac; }

mkdir -p "$EXT/dist"
(cd "$EXT" && node esbuild.mjs --production)
for t in $TARGETS; do
  rm -rf "${EXT:?}/bin"
  os="$(goos "$t")" || { echo "unknown target $t (one of: $ALL)" >&2; exit 2; }
  exe=wingman-spec; [ "$os" = windows ] && exe=wingman-spec.exe
  mkdir -p "$EXT/bin"
  (cd "$REPO" && CGO_ENABLED=0 GOOS="$os" GOARCH="$(goarch "$t")" go build -trimpath \
    -ldflags "-s -w -X github.com/Spreizu/wingman-spec/internal/cli.Version=$VERSION" -o "$EXT/bin/$exe" ./cmd/wingman-spec)
  out="$EXT/dist/wingman-spec-$t-$VERSION.vsix"
  (cd "$EXT" && $VSCE package --no-dependencies --target "$t" --out "$out")
  echo "packaged $out ($COMMIT)"
done
rm -rf "${EXT:?}/bin"
