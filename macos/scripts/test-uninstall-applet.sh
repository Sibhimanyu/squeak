#!/bin/bash
# Builds the uninstall applet into a temp dir and checks signature, bundle id and the paths in its script.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
"$HERE/scripts/build-uninstall-applet.sh" "$T" >/dev/null
A="$T/Uninstall Squeak.app"
fail() { echo "FAIL: $*" >&2; exit 1; }
codesign --verify --deep --strict "$A" || fail "signature does not verify"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$A/Contents/Info.plist")" = com.squeak.uninstall ] || fail "bundle id"
S="$(osadecompile "$A/Contents/Resources/Scripts/main.scpt")"
for want in 'Library/Application Support/squeak/daemon/current' '/node' 'dist/squeak/cli.js' \
  'uninstall --yes' '--keep-data' '/Applications/Squeak.app/Contents/Resources/daemon' \
  'Remove Squeak from this Mac? Your Mac will ask for your password to remove Squeak' 'Remove Squeak' 'no Squeak service installed'; do
  printf '%s' "$S" | grep -qF -- "$want" || fail "script text missing: $want"
done
echo "ok: uninstall applet"
