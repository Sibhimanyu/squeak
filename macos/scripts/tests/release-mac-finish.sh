#!/bin/bash
# Checks release-mac.sh's local_appcast_has and that the HTTP size check is only ever a warning.
set -euo pipefail
S="$(cd "$(dirname "$0")/.." && pwd)/release-mac.sh"
eval "$(sed -n '/^local_appcast_has()/p' "$S")"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
echo '<sparkle:shortVersionString>2.26.5</sparkle:shortVersionString>' > "$T/appcast.xml"
local_appcast_has "$T/appcast.xml" 2.26.5 || { echo "FAIL: should have 2.26.5"; exit 1; }
! local_appcast_has "$T/appcast.xml" 2.26.4 || { echo "FAIL: should not have 2.26.4"; exit 1; }
! local_appcast_has "$T/missing.xml" 2.26.5 || { echo "FAIL: missing file"; exit 1; }
if grep -n 'remote_size "' "$S" | grep -v 'WARNING'; then echo "FAIL: fatal remote_size check"; exit 1; fi
bash -n "$S"
echo ok
