#!/bin/bash
# Builds a Debug "Squeak Dev.app" (bundle id com.squeak.mac.dev) and, unless --build-only, replaces the running
# Squeak and opens it. A bundle gives the dev build notifications, permissions and its own defaults domain.
# No squeak:// scheme, no Sparkle keys (Updater only starts for com.squeak.mac), no embedded daemon: it talks to
# the daemon and host already running on loopback. Incremental: unchanged files are not re-copied.
# Output: $SQUEAK_DEV_OUT (default macos/build/dev-app)/Squeak Dev.app. Never touches /Applications.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
OUT="${SQUEAK_DEV_OUT:-$HERE/build/dev-app}"
APP="$OUT/Squeak Dev.app"
ID="com.squeak.mac.dev"
BUILD_ONLY=0
[ "${1:-}" = "--build-only" ] && BUILD_ONLY=1

cd "$HERE"
swift build --product SqueakMac
BINDIR="$(swift build --show-bin-path)"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Frameworks" "$APP/Contents/Helpers"

CHANGED=0
# sync SRC DST: copy only when content differs
sync() { if ! cmp -s "$1" "$2" 2>/dev/null; then cp "$1" "$2"; CHANGED=1; fi; }
syncdir() { # rsync keeps it incremental and preserves symlinks
  if [ -n "$(rsync -a --delete --itemize-changes "$1" "$2" | head -1)" ]; then CHANGED=1; fi
}

# The copied binary gets its own rpath below, so compare the source against a stamp, not the copy.
SUM="$(shasum "$BINDIR/SqueakMac" | cut -d' ' -f1)"
if [ "$(cat "$OUT/.binsum" 2>/dev/null)" != "$SUM" ] || [ ! -e "$APP/Contents/MacOS/SqueakMac" ]; then
  cp "$BINDIR/SqueakMac" "$APP/Contents/MacOS/SqueakMac"; echo "$SUM" > "$OUT/.binsum"; CHANGED=1
fi
# SwiftPM resource bundles (release has none; this copies any non-test bundle that exists, for Bundle.module).
for b in "$BINDIR"/*.bundle; do
  [ -d "$b" ] || continue
  case "$(basename "$b")" in *Tests.bundle) continue;; esac
  syncdir "$b/" "$APP/Contents/Resources/$(basename "$b")/"
done

SPARKLE_FW="$(find "$HERE/.build/artifacts/sparkle/Sparkle/Sparkle.xcframework" -type d -name Sparkle.framework -path '*macos-*' | head -1)"
[ -d "$SPARKLE_FW" ] || { echo "Sparkle.framework not found; run swift package resolve" >&2; exit 1; }
# Signing rewrites it, so copy once (delete the app folder after a Sparkle bump).
[ -d "$APP/Contents/Frameworks/Sparkle.framework" ] || { syncdir "$SPARKLE_FW/" "$APP/Contents/Frameworks/Sparkle.framework/"; }
if ! otool -l "$APP/Contents/MacOS/SqueakMac" | grep -q "@executable_path/../Frameworks"; then
  install_name_tool -add_rpath "@executable_path/../Frameworks" "$APP/Contents/MacOS/SqueakMac" 2>/dev/null; CHANGED=1
fi

# Helpers: build once (they are slow and rarely change); delete the file to rebuild.
for h in squeak-fans squeak-apps squeak-hands; do
  if [ ! -e "$APP/Contents/Helpers/$h" ] && [ ! -e "$APP/Contents/Helpers/Squeak Hands.app" ]; then
    "$REPO/helpers/$h/build.sh" "$APP/Contents/Helpers" >/dev/null 2>&1 || echo "note: helper $h not built" >&2
    CHANGED=1
  fi
done

BRAND="$APP/Contents/Resources/brand"
mkdir -p "$BRAND/mood-sprites" "$BRAND/agents" "$APP/Contents/Resources/fonts"
syncdir "$REPO/brand/mood-sprites/" "$BRAND/mood-sprites/"
for f in "$REPO"/brand/logo/png/squeak-duck-full-color-*.png "$REPO"/brand/logo/png/squeak-duck-compact-*.png \
         "$REPO"/brand/logo/png/squeak-lockup-horizontal-*.png "$REPO/brand/logo/png/duckTemplate.png" \
         "$REPO/brand/logo/png/duckTemplate@2x.png" "$REPO/brand/logo/png/duckThread.png" \
         "$REPO/brand/logo/png/squeak-bot-avatar-640.jpg" "$REPO"/macos/assets/agents/agent-*.png; do
  case "$f" in */agents/*|*/agent-*) sync "$f" "$BRAND/agents/$(basename "$f")";; *) sync "$f" "$BRAND/$(basename "$f")";; esac
done
for f in "$REPO"/brand/fonts/JetBrainsMono/JetBrainsMono-Regular.ttf "$REPO"/brand/fonts/JetBrainsMono/JetBrainsMono-Medium.ttf \
         "$REPO"/brand/fonts/JetBrainsMono/OFL.txt; do sync "$f" "$APP/Contents/Resources/fonts/$(basename "$f")"; done
sync "$HERE/THIRD-PARTY-NOTICES.md" "$APP/Contents/Resources/THIRD-PARTY-NOTICES.md"
sync "$HERE/assets/squeak.icns" "$APP/Contents/Resources/Squeak.icns"

PLIST="$(mktemp)"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$ID</string>
  <key>CFBundleName</key><string>Squeak Dev</string>
  <key>CFBundleDisplayName</key><string>Squeak Dev</string>
  <key>CFBundleExecutable</key><string>SqueakMac</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.0-dev</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Squeak listens only while you dictate a message, to turn your voice into text on this Mac. Nothing is recorded or sent.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Squeak turns your dictated words into text for the message you are writing. It happens on this Mac when it can.</string>
  <key>CFBundleIconFile</key><string>Squeak</string>
$(cat "$HERE/scripts/drag-types.plist.frag")
</dict>
</plist>
PL
sync "$PLIST" "$APP/Contents/Info.plist"; rm -f "$PLIST"

# Same identity lookup as build-app.sh, so grants survive rebuilds. Sign only when something changed or it is unsigned.
IDENTITY="${SQUEAK_MAC_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -1)}"
if [ -z "$IDENTITY" ] || [ "$IDENTITY" = "-" ]; then
  IDENTITY="-"; echo "WARNING: no Apple Development identity: signing AD HOC; macOS grants will not survive rebuilds." >&2
fi
if [ "$CHANGED" = 1 ] || ! codesign --verify "$APP" >/dev/null 2>&1; then
  FW="$APP/Contents/Frameworks/Sparkle.framework/Versions/B"
  for part in "$FW/XPCServices/Installer.xpc" "$FW/XPCServices/Downloader.xpc" "$FW/Autoupdate" "$FW/Updater.app"; do
    [ -e "$part" ] && codesign -s "$IDENTITY" --force "$part"
  done
  codesign -s "$IDENTITY" --force "$APP/Contents/Frameworks/Sparkle.framework"
  [ -e "$APP/Contents/Helpers/squeak-fans" ] && codesign -s "$IDENTITY" --force --identifier com.squeak.fans "$APP/Contents/Helpers/squeak-fans"
  [ -e "$APP/Contents/Helpers/squeak-apps" ] && codesign -s "$IDENTITY" --force --identifier com.squeak.apps "$APP/Contents/Helpers/squeak-apps"
  codesign -s "$IDENTITY" --force --identifier "$ID" "$APP"
  codesign --verify --strict "$APP"
fi
echo "Built $APP (signed: $IDENTITY)"
[ "$BUILD_ONLY" = 1 ] && exit 0

# One-time defaults carry-over from the unbundled build's domain.
if ! defaults read "$ID" >/dev/null 2>&1 && defaults read SqueakMac >/dev/null 2>&1; then
  defaults export SqueakMac - | defaults import "$ID" - && echo "copied SqueakMac defaults to $ID"
fi

# Quit whatever Squeak is running (SIGTERM: the installed app ignores AppleScript quit), then open the dev bundle.
pkill -TERM -f "Products/Debug/SqueakMac" || true
pkill -TERM -f "Squeak Dev.app/Contents/MacOS/SqueakMac" || true
pkill -TERM -f "/Applications/Squeak.app/Contents/MacOS/SqueakMac" || true
sleep 1
open "$APP"
echo "Squeak Dev running"
