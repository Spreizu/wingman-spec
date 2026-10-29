#!/usr/bin/env bash
# Offline tests of the figma-to-code skill's helper (URL parser, normaliser, token mapping, diff, CLI against a stub server).
# Usage: tests/figma-to-code.sh   (needs node >= 18). No network and no Figma token are used.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
unset FIGMA_TOKEN FIGMA_API_BASE
exec node --test "$PKG/tests/figma-to-code.test.mjs"
