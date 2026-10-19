#!/bin/bash
# Builds macos/build/Squeak.app (ad-hoc signed, Sparkle embedded) and
# macos/build/Squeak-<version>.zip + .sha256.
# Output stays inside macos/build. Never installs anywhere and never makes a DMG.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
VERSION="2.0.5"
# Sparkle compares CFBundleVersion, so it must only ever grow: 2.0.2 -> 20002, 2.1.0 -> 20100.
# (A pre-release suffix is ignored; give a beta its own patch number if it must be offered.)
IFS=. read -r V_MAJOR V_MINOR V_PATCH <<<"${VERSION%%-*}"
BUILD_NUMBER=$(( V_MAJOR * 10000 + V_MINOR * 100 + V_PATCH ))
SPARKLE_PUBLIC_KEY="igUigqK9pL8iEbWsuR+4z6O//LeVw9h5hOeR/T0EM3Y="
FEED_URL="https://sibhimanyu.github.io/squeak/appcast.xml"
OUT="$HERE/build"
APP="$OUT/Squeak.app"

cd "$HERE"
swift build -c release --arch arm64
BIN="$(swift build -c release --arch arm64 --show-bin-path)/SqueakMac"

rm -rf "$APP" "$OUT/Squeak-$VERSION.zip" "$OUT/Squeak-$VERSION.zip.sha256"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/SqueakMac"

# Sparkle.framework from SwiftPM's binary artifact; ditto keeps its symlinks.
SPARKLE_FW="$(find "$HERE/.build/artifacts/sparkle/Sparkle/Sparkle.xcframework" -type d -name Sparkle.framework -path '*macos-*' | head -1)"
[ -d "$SPARKLE_FW" ] || { echo "Sparkle.framework not found; run swift package resolve" >&2; exit 1; }
mkdir -p "$APP/Contents/Frameworks"
ditto "$SPARKLE_FW" "$APP/Contents/Frameworks/Sparkle.framework"
# SwiftPM links with an rpath into .build; the bundle needs its own.
if ! otool -l "$APP/Contents/MacOS/SqueakMac" | grep -q "@executable_path/../Frameworks"; then
  install_name_tool -add_rpath "@executable_path/../Frameworks" "$APP/Contents/MacOS/SqueakMac"
fi

# The brand's own duck files (DESIGN.md 6.1) and the menu-bar template; the app never redraws them.
BRAND="$APP/Contents/Resources/brand"
mkdir -p "$BRAND"
cp "$REPO"/brand/logo/png/squeak-duck-full-color-*.png "$REPO"/brand/logo/png/squeak-duck-compact-*.png \
   "$REPO"/brand/logo/png/squeak-lockup-horizontal-*.png "$BRAND/"
cp "$REPO/desktop/assets/duckTemplate.png" "$REPO/desktop/assets/duckTemplate@2x.png" "$BRAND/"

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
  <key>CFBundleVersion</key><string>$BUILD_NUMBER</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Copyright © 2026 Squeak. All rights reserved.</string>
  <key>SUFeedURL</key><string>$FEED_URL</string>
  <key>SUPublicEDKey</key><string>$SPARKLE_PUBLIC_KEY</string>
  <key>SUEnableAutomaticChecks</key><true/>
  <key>SUScheduledCheckInterval</key><integer>86400</integer>
  <key>SUAllowsAutomaticUpdates</key><true/>
  $ICON_KEY
</dict>
</plist>
PLIST

# Ad-hoc signing, inside out (no --deep): Sparkle's helpers, then the framework, then the app.
# No hardened runtime: its library validation would refuse an ad-hoc framework (no Team ID).
FW="$APP/Contents/Frameworks/Sparkle.framework/Versions/B"
for part in "$FW/XPCServices/Installer.xpc" "$FW/XPCServices/Downloader.xpc" "$FW/Autoupdate" "$FW/Updater.app"; do
  codesign -s - --force "$part"
done
codesign -s - --force "$APP/Contents/Frameworks/Sparkle.framework"
codesign -s - --force "$APP"
codesign --verify --deep --strict "$APP"

(cd "$OUT" && ditto -c -k --keepParent Squeak.app "Squeak-$VERSION.zip")
(cd "$OUT" && shasum -a 256 "Squeak-$VERSION.zip" | tee "Squeak-$VERSION.zip.sha256")
echo "Built $APP"
