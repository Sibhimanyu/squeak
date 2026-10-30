#!/bin/bash
# Builds "Uninstall Squeak.app" (osacompile applet, bundle id com.squeak.uninstall) into <outdir>,
# signed with the same identity lookup as build-app.sh (ad hoc if none).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUTDIR="${1:?usage: build-uninstall-applet.sh <outdir>}"
APPLET="$OUTDIR/Uninstall Squeak.app"
rm -rf "$APPLET"
osacompile -o "$APPLET" "$HERE/scripts/uninstall-applet.applescript"
PLIST="$APPLET/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier com.squeak.uninstall' "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string com.squeak.uninstall' "$PLIST"
/usr/libexec/PlistBuddy -c 'Set :CFBundleName Uninstall Squeak' "$PLIST" 2>/dev/null || true
cp "$HERE/build/Squeak.app/Contents/Resources/Squeak.icns" "$APPLET/Contents/Resources/applet.icns" 2>/dev/null || true
IDENTITY="${SQUEAK_MAC_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -1)}"
[ -n "$IDENTITY" ] || IDENTITY="-"
codesign -s "$IDENTITY" --force "$APPLET"
codesign --verify --deep --strict "$APPLET"
echo "$APPLET"
