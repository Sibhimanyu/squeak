#!/bin/bash
# Packages macos/build/Squeak.app as a drag-to-install DMG.
# Never `hdiutil create -srcfolder` (or create-dmg): endpoint security on this
# Mac holds the volume and it fails with "Resource busy". Empty image, mount,
# copy, lay out, convert.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$HERE/build/Squeak.app/Contents/Info.plist")"
APP="$HERE/build/Squeak.app"
NAME="Squeak"
VOLNAME="Squeak $VERSION"
OUT="$HERE/build/Squeak-$VERSION.dmg"
WIN_W=680; WIN_H=460
APP_X=170; APP_Y=224
DEST_X=510; DEST_Y=224

[ -d "$APP" ] || { echo "build the app first: scripts/build-app.sh" >&2; exit 1; }

WORK="$(mktemp -d)"; RW="$WORK/rw.dmg"; MOUNT="$WORK/mnt"; mkdir "$MOUNT"
trap 'hdiutil detach "$MOUNT" -force >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

swift "$HERE/scripts/dmg-background.swift" "$WORK"
tiffutil -cathidpicheck "$WORK/bg.png" "$WORK/bg@2x.png" -out "$WORK/background.tiff" >/dev/null

SIZE_MB=$(( $(du -sm "$APP" | cut -f1) + 64 ))
hdiutil create -size "${SIZE_MB}m" -fs HFS+ -volname "$VOLNAME" -type UDIF "$RW" >/dev/null
hdiutil attach "$RW" -noautoopen -mountpoint "$MOUNT" >/dev/null

ditto "$APP" "$MOUNT/$NAME.app"
ln -s /Applications "$MOUNT/Applications"
mkdir "$MOUNT/.background"
cp "$WORK/background.tiff" "$MOUNT/.background/background.tiff"
cp "$APP/Contents/Resources/Squeak.icns" "$MOUNT/.VolumeIcon.icns"
SetFile -a C "$MOUNT" 2>/dev/null || true

osascript <<EOF || echo "warning: Finder layout skipped (allow Automation for this terminal); the DMG still installs" >&2
tell application "Finder"
  set theDisk to (POSIX file "$MOUNT" as alias)
  open theDisk
  set theWindow to container window of theDisk
  set current view of theWindow to icon view
  set toolbar visible of theWindow to false
  set statusbar visible of theWindow to false
  set bounds of theWindow to {200, 120, $((200 + WIN_W)), $((120 + WIN_H))}
  set viewOptions to icon view options of theWindow
  set arrangement of viewOptions to not arranged
  set icon size of viewOptions to 128
  set background picture of viewOptions to file ".background:background.tiff" of theDisk
  set position of item "$NAME.app" of theDisk to {$APP_X, $APP_Y}
  set position of item "Applications" of theDisk to {$DEST_X, $DEST_Y}
  close theWindow
  open theDisk
  update theDisk without registering applications
  delay 2
  close container window of theDisk
end tell
EOF
for _ in $(seq 1 20); do [ -f "$MOUNT/.DS_Store" ] && break; sleep 0.5; done

for f in .background .VolumeIcon.icns .fseventsd .Trashes; do
  [ -e "$MOUNT/$f" ] && chflags hidden "$MOUNT/$f"
done

sync; sleep 2
hdiutil detach "$MOUNT" -force >/dev/null
rm -f "$OUT"
hdiutil convert "$RW" -format UDZO -o "$OUT" >/dev/null

hdiutil verify "$OUT" >/dev/null
V="$WORK/verify"; mkdir "$V"
hdiutil attach "$OUT" -nobrowse -noautoopen -mountpoint "$V" >/dev/null
codesign --verify --deep --strict "$V/$NAME.app"
hdiutil detach "$V" -force >/dev/null

(cd "$HERE/build" && shasum -a 256 "$(basename "$OUT")" > "$(basename "$OUT").sha256")
echo "$OUT"
cat "$OUT.sha256"
