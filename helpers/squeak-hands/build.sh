#!/bin/sh
# Build Squeak Hands.app. Usage: build.sh <output-dir>
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:?output dir}"
app="$out/Squeak Hands.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
swiftc -O -o "$app/Contents/MacOS/squeak-hands" "$here/main.swift" -framework AppKit -framework ApplicationServices -framework CryptoKit
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.squeak.hands</string>
  <key>CFBundleName</key><string>Squeak Hands</string>
  <key>CFBundleExecutable</key><string>squeak-hands</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>Squeak Hands types your replies into the Terminal tab where that agent is running.</string>
</dict></plist>
PLIST
# Sign with a real identity when there is one. macOS ties an Accessibility
# grant to the signature: ad-hoc signatures change on every build, so each
# rebuild would silently revoke the permission; a certificate plus a fixed
# bundle id survives rebuilds. SQUEAK_HANDS_SIGN_IDENTITY overrides the pick.
identity="${SQUEAK_HANDS_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -1)}"
codesign --force --sign "${identity:--}" "$app"
echo "$app"
