#!/usr/bin/env bash
# shellcheck disable=SC2016 # the expect snippets are eval'd later
# install.sh against a local mirror of a release (WINGMAN_SPEC_DOWNLOAD=file://...): download, checksum, install, refusals.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0; rc=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }
command -v curl >/dev/null || { echo "installer: skipped (no curl)"; exit 0; }

case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "installer: skipped ($(uname -s))"; exit 0 ;; esac
case "$(uname -m)" in x86_64 | amd64) arch=amd64 ;; *) arch=arm64 ;; esac
V=9.9.9
A="wingman-spec_${V}_${os}_${arch}.tar.gz"
mkdir -p "$T/stage" "$T/mirror/v$V"
printf '#!/bin/sh\necho "wingman-spec version %s"\n' "$V" > "$T/stage/wingman-spec" && chmod 755 "$T/stage/wingman-spec"
tar -czf "$T/mirror/v$V/$A" -C "$T/stage" wingman-spec
(cd "$T/mirror/v$V" && { sha256sum "$A" 2>/dev/null || shasum -a 256 "$A"; } > checksums.txt)
run() { rc=0; env -u WINGMAN_SPEC_VERSION WINGMAN_SPEC_DOWNLOAD="file://$T/mirror" WINGMAN_SPEC_INSTALL="$T/bin" "$@" sh "$PKG/install.sh" > "$T/o" 2>&1 || rc=$?; }

run WINGMAN_SPEC_VERSION=v$V
expect "installs the release binary into WINGMAN_SPEC_INSTALL (a leading v in the version is accepted)" '[ $rc = 0 ] && [ -x "$T/bin/wingman-spec" ] && grep -q "Installed $T/bin/wingman-spec (wingman-spec version $V)" "$T/o"'
expect "says how to put the folder on the PATH and what to run next" 'grep -q "Add $T/bin to your PATH" "$T/o" && grep -q "wingman-spec init --harness all" "$T/o"'
printf 'tampered' >> "$T/mirror/v$V/$A"
run WINGMAN_SPEC_VERSION=$V
expect "a checksum mismatch is refused and nothing is replaced" '[ $rc = 1 ] && grep -q "checksum mismatch" "$T/o"'
run WINGMAN_SPEC_VERSION=1.0.0
expect "a version without a release archive is refused with its name" '[ $rc = 1 ] && grep -q "no wingman-spec_1.0.0_${os}_${arch}.tar.gz in release v1.0.0" "$T/o"'

echo "installer: passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
