#!/bin/bash
# Embeds the Squeak daemon into an app bundle: <app>/Contents/Resources/daemon/
#   node            pinned standalone Node (arm64), signed with JIT entitlements
#   dist/           the compiled daemon (built in a temp dir, never the repo's dist)
#   node_modules/   production dependencies only, built against the bundled Node's ABI
#   package.json, VERSION ("<package version>+<git short sha>")
# Usage: embed-daemon.sh <Squeak.app> <codesign identity | ->
# Fails loudly: no network and no cached Node is an error, never a silent skip.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
APP="${1:?usage: embed-daemon.sh <Squeak.app> <identity>}"
IDENTITY="${2:?usage: embed-daemon.sh <Squeak.app> <identity>}"

# Pinned: bump both together (SHA from https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt).
NODE_VERSION="22.23.1"
NODE_SHA256="ef28d8fab2c0e4314522d4bb1b7173270aa3937e93b92cb7de79c112ac1fa953"
TARBALL="node-v$NODE_VERSION-darwin-arm64.tar.gz"
CACHE="$HERE/build/cache"
DEST="$APP/Contents/Resources/daemon"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/squeak-daemon.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$CACHE"
if [ ! -f "$CACHE/$TARBALL" ] || [ "$(shasum -a 256 "$CACHE/$TARBALL" | cut -d' ' -f1)" != "$NODE_SHA256" ]; then
  rm -f "$CACHE/$TARBALL"
  echo "Fetching Node $NODE_VERSION"
  curl -fsSL --retry 2 -o "$CACHE/$TARBALL.part" "https://nodejs.org/dist/v$NODE_VERSION/$TARBALL" \
    || { echo "embed-daemon: cannot download Node $NODE_VERSION and none is cached in $CACHE" >&2; exit 1; }
  mv "$CACHE/$TARBALL.part" "$CACHE/$TARBALL"
fi
[ "$(shasum -a 256 "$CACHE/$TARBALL" | cut -d' ' -f1)" = "$NODE_SHA256" ] \
  || { echo "embed-daemon: SHA-256 mismatch for $TARBALL" >&2; rm -f "$CACHE/$TARBALL"; exit 1; }

mkdir -p "$WORK/node-dist"
tar -xzf "$CACHE/$TARBALL" -C "$WORK/node-dist"
NODE_ROOT="$WORK/node-dist/node-v$NODE_VERSION-darwin-arm64"
NODE="$NODE_ROOT/bin/node"
[ "$("$NODE" -v)" = "v$NODE_VERSION" ] || { echo "embed-daemon: bundled node reports the wrong version" >&2; exit 1; }

# Build in a temp copy so the repo's dist and node_modules are never touched.
STAGE="$WORK/stage"
mkdir -p "$STAGE"
cp "$REPO/package.json" "$REPO/package-lock.json" "$REPO/tsconfig.json" "$REPO/tsconfig.build.json" "$STAGE/"
cp -R "$REPO/src" "$STAGE/src"
# Types and tsc come from the repo's own devDependencies, through a symlink (read-only use).
ln -s "$REPO/node_modules" "$STAGE/node_modules"
(cd "$STAGE" && "$REPO/node_modules/.bin/tsc" -p tsconfig.build.json)
rm "$STAGE/node_modules"
[ -f "$STAGE/dist/squeak/cli.js" ] || { echo "embed-daemon: tsc produced no dist/squeak/cli.js" >&2; exit 1; }

# Production dependencies, with the bundled Node first on PATH so better-sqlite3 fetches (or builds) for its ABI.
(cd "$STAGE" && PATH="$NODE_ROOT/bin:$PATH" "$NODE_ROOT/bin/node" "$NODE_ROOT/lib/node_modules/npm/bin/npm-cli.js" ci --omit=dev --ignore-scripts=false --no-audit --no-fund --loglevel=error)

# Prune what a running daemon never reads.
find "$STAGE/node_modules" \( -name '*.map' -o -name '*.md' -o -name '*.markdown' \) -type f -delete 2>/dev/null || true
find "$STAGE/node_modules" -type d \( -name test -o -name tests -o -name docs -o -name example -o -name examples -o -name .github \) -prune -exec rm -rf {} + 2>/dev/null || true
BSQ="$STAGE/node_modules/better-sqlite3"
if [ -d "$BSQ" ]; then
  rm -rf "$BSQ/deps" "$BSQ/src" "$BSQ/build/Release/obj" "$BSQ/build/Release/.deps" "$BSQ/build/deps" "$BSQ/build/Makefile" "$BSQ/build/config.gypi"
  find "$BSQ/build" -type f ! -name '*.node' -delete 2>/dev/null || true
fi
find "$STAGE/dist" -name '*.map' -type f -delete

PKG_VERSION="$("$NODE" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$STAGE/package.json")"
SHA="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo nogit)"
DAEMON_VERSION="$PKG_VERSION+$SHA"

rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$STAGE/dist" "$STAGE/node_modules" "$STAGE/package.json" "$DEST/"
cp "$NODE" "$DEST/node"
# The Telegram bot's avatar (src/telegram/avatar.ts looks for ../../brand/logo/png from dist/telegram): one small file.
AVATAR="squeak-bot-avatar-640.jpg"
[ -f "$REPO/brand/logo/png/$AVATAR" ] || { echo "embed-daemon: brand/logo/png/$AVATAR is missing" >&2; exit 1; }
mkdir -p "$DEST/brand/logo/png"
cp "$REPO/brand/logo/png/$AVATAR" "$DEST/brand/logo/png/$AVATAR"
printf '%s\n' "$DAEMON_VERSION" > "$DEST/VERSION"

# Signing: node needs JIT entitlements (V8); library validation is off so it can load the .node addon,
# which we sign with the same identity anyway. No hardened runtime is requested by the app, but these
# entitlements are harmless without it and keep the binary valid if one is ever added.
ENT="$WORK/node.entitlements"
cat > "$ENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
PLIST
while IFS= read -r f; do
  codesign -s "$IDENTITY" --force "$f"
done < <(find "$DEST/node_modules" \( -name '*.node' -o -name '*.dylib' \) -type f)
codesign -s "$IDENTITY" --force --options runtime --entitlements "$ENT" --identifier com.squeak.daemon.node "$DEST/node"

# Smoke: the bundled node must run the bundled daemon's CLI and load the native module.
"$DEST/node" "$DEST/dist/squeak/cli.js" help >/dev/null \
  || { echo "embed-daemon: smoke failed: cli.js help" >&2; exit 1; }
(cd "$DEST" && "$DEST/node" -e 'const D=require("better-sqlite3");const d=new D(":memory:");if(d.prepare("select 1 as x").get().x!==1)process.exit(1)') \
  || { echo "embed-daemon: smoke failed: better-sqlite3 does not load in the bundled node" >&2; exit 1; }
echo "Embedded daemon $DAEMON_VERSION ($(du -sh "$DEST" | cut -f1)) in $DEST"
