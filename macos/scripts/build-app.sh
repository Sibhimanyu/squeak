#!/bin/bash
# Builds macos/build/Squeak.app (signed with the Apple Development identity, ad hoc with a warning if none; Sparkle embedded) and
# macos/build/Squeak-<version>.zip + .sha256.
# Output stays inside macos/build. Never installs anywhere and never makes a DMG.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
VERSION="2.12.32"
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

# squeak-fans (helpers/squeak-fans): reads temperatures and fans for the daemon, and is what Settings ›
# Keep awake › Set up fan control installs root-owned. Signed below with the app's identity, which the
# installer checks before the admin prompt.
mkdir -p "$APP/Contents/Helpers"
"$REPO/helpers/squeak-fans/build.sh" "$APP/Contents/Helpers" >/dev/null
# squeak-apps (helpers/squeak-apps): the running and installed apps, and a polite quit, for the iPhone's
# Mac controls page. No permission needed.
"$REPO/helpers/squeak-apps/build.sh" "$APP/Contents/Helpers" >/dev/null
# Squeak Hands (helpers/squeak-hands): types replies into Conductor/Terminal and reports its own grants.
# It signs itself with the Apple Development identity (the grant is tied to it). The app copies it to
# ~/Library/Application Support/squeak/Squeak Hands.app when that is missing or older (HandsInstaller).
"$REPO/helpers/squeak-hands/build.sh" "$APP/Contents/Helpers" >/dev/null

# The brand's own duck files (DESIGN.md 6.1) and the menu-bar template; the app never redraws them.
BRAND="$APP/Contents/Resources/brand"
mkdir -p "$BRAND"
cp "$REPO"/brand/logo/png/squeak-duck-full-color-*.png "$REPO"/brand/logo/png/squeak-duck-compact-*.png \
   "$REPO"/brand/logo/png/squeak-lockup-horizontal-*.png "$BRAND/"
cp "$REPO/brand/logo/png/duckTemplate.png" "$REPO/brand/logo/png/duckTemplate@2x.png" "$BRAND/"
# Native floating duck mood sprites (the window reads these from the app bundle at runtime).
mkdir -p "$BRAND/mood-sprites"
cp "$REPO"/brand/mood-sprites/duck*.png "$BRAND/mood-sprites/"
# The bot's profile picture (Telegram's "Use Squeak logo", Cliq's "Save logo"): the same JPG the daemon uploads.
cp "$REPO/brand/logo/png/squeak-bot-avatar-640.jpg" "$BRAND/"
# The Claude, Codex and Conductor marks (the same PNGs the iPhone ships); AgentMark reads them from brand/agents.
mkdir -p "$BRAND/agents"
cp "$REPO"/macos/assets/agents/agent-*.png "$BRAND/agents/"

ICON=""
for c in "$REPO/macos/assets/squeak.icns"; do [ -f "$c" ] && ICON="$c"; done
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
  <key>SUScheduledCheckInterval</key><integer>3600</integer>
  <key>SUAllowsAutomaticUpdates</key><true/>
  $ICON_KEY
</dict>
</plist>
PLIST

# Signing, inside out (no --deep): Sparkle's helpers, then the framework, then the app.
# macOS ties the Input Monitoring grant (double-tap shortcut) to the app's code identity. An ad-hoc
# signature is a new identity every build, so every update would silently lose the grant. Sign with the
# Apple Development identity instead (the same lookup as helpers/squeak-hands/build.sh, which exists for
# the same reason): its designated requirement names the bundle id and certificate, not a cdhash, and
# survives rebuilds. SQUEAK_MAC_SIGN_IDENTITY overrides the pick; "-" forces ad hoc.
# No hardened runtime: nothing here needs it, and it would add library validation for no gain.
IDENTITY="${SQUEAK_MAC_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -1)}"
if [ -z "$IDENTITY" ] || [ "$IDENTITY" = "-" ]; then
  IDENTITY="-"
  echo "################################################################" >&2
  echo "WARNING: no Apple Development identity in the keychain: signing AD HOC." >&2
  echo "Every build gets a new code identity, so macOS will drop Squeak's Input" >&2
  echo "Monitoring grant (double-tap shortcut) on each update. Do not release this." >&2
  echo "################################################################" >&2
else
  echo "Signing with: $IDENTITY"
fi
# The daemon (Contents/Resources/daemon): compiled JS, production node_modules and a pinned Node,
# so a Mac app update also updates the daemon (DaemonManager installs it outside the app).
"$HERE/scripts/embed-daemon.sh" "$APP" "$IDENTITY"
FW="$APP/Contents/Frameworks/Sparkle.framework/Versions/B"
for part in "$FW/XPCServices/Installer.xpc" "$FW/XPCServices/Downloader.xpc" "$FW/Autoupdate" "$FW/Updater.app"; do
  codesign -s "$IDENTITY" --force "$part"
done
codesign -s "$IDENTITY" --force "$APP/Contents/Frameworks/Sparkle.framework"
codesign -s "$IDENTITY" --force --identifier com.squeak.fans "$APP/Contents/Helpers/squeak-fans"
codesign -s "$IDENTITY" --force --identifier com.squeak.apps "$APP/Contents/Helpers/squeak-apps"
codesign -s "$IDENTITY" --force "$APP"
codesign --verify --deep --strict "$APP"

(cd "$OUT" && ditto -c -k --keepParent Squeak.app "Squeak-$VERSION.zip")
(cd "$OUT" && shasum -a 256 "Squeak-$VERSION.zip" | tee "Squeak-$VERSION.zip.sha256")
echo "Built $APP"
