#!/bin/bash
# Builds macos/build/Squeak.app (ad-hoc signed) and macos/build/Squeak-2.0.0.zip + .sha256.
# Output stays inside macos/build. Never installs anywhere and never makes a DMG.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
VERSION="2.0.1"
OUT="$HERE/build"
APP="$OUT/Squeak.app"

cd "$HERE"
swift build -c release --arch arm64
BIN="$(swift build -c release --arch arm64 --show-bin-path)/SqueakMac"

rm -rf "$APP" "$OUT/Squeak-$VERSION.zip" "$OUT/Squeak-$VERSION.zip.sha256"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/SqueakMac"

ICON=""
for c in "$REPO/desktop/build/squeak.icns"; do [ -f "$c" ] && ICON="$c"; done
ICON_KEY=""
if [ -n "$ICON" ]; then
  cp "$ICON" "$APP/Contents/Resources/Squeak.icns"
  ICON_KEY="<key>CFBundleIconFile</key><string>Squeak</string>"
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.squeak.mac</string>
  <key>CFBundleName</key><string>Squeak</string>
  <key>CFBundleDisplayName</key><string>Squeak</string>
  <key>CFBundleExecutable</key><string>SqueakMac</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Copyright © 2026 Squeak. All rights reserved.</string>
  $ICON_KEY
</dict>
</plist>
PLIST

codesign -s - --force --deep "$APP"
codesign --verify --deep --strict "$APP"

(cd "$OUT" && ditto -c -k --keepParent Squeak.app "Squeak-$VERSION.zip")
(cd "$OUT" && shasum -a 256 "Squeak-$VERSION.zip" | tee "Squeak-$VERSION.zip.sha256")
echo "Built $APP"
