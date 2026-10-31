#!/bin/sh
# install.sh: download the wingman-spec CLI from a GitHub release, check its checksum and put it on the PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/Spreizu/wingman-spec/main/install.sh | sh
#
# Environment:
#   WINGMAN_SPEC_VERSION   a release version such as 0.12.0 (default: the latest release)
#   WINGMAN_SPEC_INSTALL   the folder for the binary (default: $HOME/.local/bin)
#   WINGMAN_SPEC_DOWNLOAD  a mirror of the release files: <url>/v<version>/<archive> (default: the GitHub releases)
#
# Then, in a project: wingman-spec init --harness all
# Windows: download wingman-spec_<version>_windows_<arch>.zip from the release page and put wingman-spec.exe on the PATH,
# or install the VS Code extension, which bundles the binary.
set -eu

REPO="Spreizu/wingman-spec"
DIR="${WINGMAN_SPEC_INSTALL:-$HOME/.local/bin}"
VERSION="${WINGMAN_SPEC_VERSION:-}"

fail() { echo "install.sh: $*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "unsupported system $(uname -s): download a release archive from https://github.com/$REPO/releases" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "unsupported CPU $(uname -m)" ;;
esac

if command -v curl >/dev/null 2>&1; then
  get() { curl -fsSL "$1"; }
  save() { curl -fsSL -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  get() { wget -qO- "$1"; }
  save() { wget -qO "$2" "$1"; }
else
  fail "needs curl or wget"
fi

if [ -z "$VERSION" ]; then
  VERSION="$(get "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$VERSION" ] || fail "could not read the latest release; set WINGMAN_SPEC_VERSION"
fi
VERSION="${VERSION#v}"

archive="wingman-spec_${VERSION}_${os}_${arch}.tar.gz"
base="${WINGMAN_SPEC_DOWNLOAD:-https://github.com/$REPO/releases/download}/v$VERSION"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading wingman-spec $VERSION ($os/$arch)"
save "$base/$archive" "$tmp/$archive" || fail "no $archive in release v$VERSION"
save "$base/checksums.txt" "$tmp/checksums.txt" || fail "no checksums.txt in release v$VERSION"

want="$(grep " $archive\$" "$tmp/checksums.txt" | cut -d' ' -f1)"
[ -n "$want" ] || fail "$archive is not listed in checksums.txt"
if command -v sha256sum >/dev/null 2>&1; then
  have="$(sha256sum "$tmp/$archive" | cut -d' ' -f1)"
else
  have="$(shasum -a 256 "$tmp/$archive" | cut -d' ' -f1)"
fi
[ "$want" = "$have" ] || fail "checksum mismatch for $archive"

tar -xzf "$tmp/$archive" -C "$tmp" wingman-spec
mkdir -p "$DIR"
install -m 0755 "$tmp/wingman-spec" "$DIR/wingman-spec" 2>/dev/null || { cp "$tmp/wingman-spec" "$DIR/wingman-spec" && chmod 0755 "$DIR/wingman-spec"; }
echo "Installed $DIR/wingman-spec ($("$DIR/wingman-spec" --version 2>/dev/null || echo "$VERSION"))"

case ":$PATH:" in
  *":$DIR:"*) ;;
  *) echo "Add $DIR to your PATH, e.g. echo 'export PATH=\"$DIR:\$PATH\"' >> ~/.profile" ;;
esac
echo "Next, in a project: wingman-spec init --harness all"
