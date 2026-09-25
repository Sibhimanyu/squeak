#!/usr/bin/env bash
#
# Build Squeak.app: a real Mac app (Spotlight, Launchpad, Finder, ⌘-Tab) that
# opens the Squeak window and runs the duck — no Terminal needed.
#
# The bundle is Electron with a two-line loader for its own code, which runs
# desktop/main.js from the MAIN CHECKOUT, the same place the launch agents
# point. So `ship.sh` updates the app's behaviour without rebuilding it, and
# archiving a Conductor worktree can never break it. Rebuild only when the
# icon, the bundle metadata or the Electron version changes.
#
# Usage: scripts/build-squeak-app.sh [install-dir]   (default: ~/Applications)

set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { printf 'build-squeak-app: %s\n' "$*" >&2; exit 1; }

REPO_ROOT="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_DIR="${1:-$HOME/Applications}"
APP="$INSTALL_DIR/Squeak.app"
PLIST_BUDDY=/usr/libexec/PlistBuddy

ELECTRON_APP="$REPO_ROOT/desktop/node_modules/electron/dist/Electron.app"
[ -d "$ELECTRON_APP" ] || die "no Electron at $ELECTRON_APP -- run npm install in $REPO_ROOT/desktop"
[ -f "$REPO_ROOT/desktop/main.js" ] || die "no desktop/main.js in $REPO_ROOT"
ICON="$HERE/desktop/build/squeak.icns"
[ -f "$ICON" ] || die "no icon at $ICON"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
STAGED="$STAGE/Squeak.app"

say "copying Electron..."
ditto "$ELECTRON_APP" "$STAGED"

# Electron runs Resources/app when there is no default_app.asar.
rm -f "$STAGED/Contents/Resources/default_app.asar"
mkdir -p "$STAGED/Contents/Resources/app"
cat > "$STAGED/Contents/Resources/app/package.json" <<JSON
{ "name": "squeak", "productName": "Squeak", "version": "1.0.0", "main": "main.js", "private": true }
JSON
ENTRY_JSON="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$REPO_ROOT/desktop/main.js")"
cat > "$STAGED/Contents/Resources/app/main.js" <<JS
// Squeak's code lives in the main checkout, so shipping updates the app.
// SQUEAK_DESKTOP_MAIN points it at a worktree instead, for testing a change.
require(process.env.SQUEAK_DESKTOP_MAIN || $ENTRY_JSON);
JS

cp "$ICON" "$STAGED/Contents/Resources/squeak.icns"
rm -f "$STAGED/Contents/Resources/electron.icns"

INFO="$STAGED/Contents/Info.plist"
set_key() {
  "$PLIST_BUDDY" -c "Set :$1 $2" "$INFO" 2>/dev/null || "$PLIST_BUDDY" -c "Add :$1 ${3:-string} $2" "$INFO"
}
set_key CFBundleName Squeak
set_key CFBundleDisplayName Squeak
set_key CFBundleIdentifier com.squeak.app
set_key CFBundleIconFile squeak.icns
set_key CFBundleShortVersionString 1.0.0
# Starts as a menu-bar app: no Dock bounce at login. The window asks for a
# Dock icon itself while it is open (desktop/main.js, openSqueak).
set_key LSUIElement true bool

# A real identity if there is one, as for Squeak Hands; ad-hoc otherwise.
identity="${SQUEAK_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -1)}"
say "signing with ${identity:-an ad-hoc signature}..."
codesign --force --deep --sign "${identity:--}" "$STAGED" 2>&1 | grep -v "replacing existing signature" || true
codesign --verify --deep --strict "$STAGED" || die "signature does not verify"

mkdir -p "$INSTALL_DIR"
if [ -d "$APP" ]; then
  rm -rf "$APP.old"
  mv "$APP" "$APP.old"
fi
mv "$STAGED" "$APP"
rm -rf "$APP.old"
# Tell Launch Services and Spotlight about it now rather than eventually.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true

say "built $APP"
say "loads $REPO_ROOT/desktop/main.js"
