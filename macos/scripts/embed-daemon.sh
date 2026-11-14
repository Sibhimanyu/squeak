#!/bin/bash
# Embeds the Squeak daemon into an app bundle: <app>/Contents/Resources/daemon/
#   node            pinned standalone Node (arm64), signed with JIT entitlements
#   dist/squeak/    the daemon as one esbuild bundle (cli.js + a few lazy chunks, ~40 files, not ~600 + ~5,700 in
#                   node_modules: endpoint-security software scans every file a first run opens, and a managed Mac
#                   took minutes with no output). Entry stays dist/squeak/cli.js, so the launch agent is unchanged.
#   node_modules/   only the true native (better-sqlite3 and what it loads), built against the bundled Node's ABI
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
# Add-ons (addons/<name>/): core is built from src/ alone, so none is compiled into it, and nothing in core may
# import one. The distributed ones (`"distributed": true` in addon.json: conductor, rasanai, claude-external, codex-external) are bundled below, each one
# self-contained, into dist/addons/<name>/ beside the daemon; the daemon loads them at start and they stay inert until
# the owner enables them. Development add-ons (conductor-relay: it redirects Conductor's paid Remote Control host to a
# loopback server) are never distributed: this refuses a bundle that has one.
[ ! -e "$STAGE/dist/addons" ] || { echo "embed-daemon: an add-on is in the core build" >&2; exit 1; }
if grep -rnE "^import .*addons/|^export .*from .*addons/" "$STAGE/dist" --include='*.js' | grep -q .; then
  echo "embed-daemon: a module imports an add-on" >&2; exit 1
fi
ADDONS_OUT="$WORK/addons-out"
mkdir -p "$ADDONS_OUT" "$STAGE/addons"
for ADDON_DIR in "$REPO"/addons/*/; do
  ADDON="$(basename "$ADDON_DIR")"
  [ -f "$ADDON_DIR/addon.json" ] || continue
  "$NODE" -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).distributed===true?0:1)' "$ADDON_DIR/addon.json" || continue
  mkdir -p "$STAGE/addons/$ADDON" "$ADDONS_OUT/$ADDON"
  rsync -a --exclude '*.test.ts' --exclude scripts "$ADDON_DIR" "$STAGE/addons/$ADDON/"
  "$REPO/node_modules/.bin/esbuild" "$STAGE/addons/$ADDON/index.ts" --bundle --platform=node --format=esm --target=node22 \
    --external:better-sqlite3 --log-level=warning --legal-comments=none \
    --banner:js='import{createRequire as __squeakCreateRequire}from"node:module";const require=__squeakCreateRequire(import.meta.url);' \
    --outfile="$ADDONS_OUT/$ADDON/index.js"
  cp "$ADDON_DIR/addon.json" "$ADDONS_OUT/$ADDON/addon.json"
done
# Every distributed add-on (conductor, rasanai, claude-external, codex-external, whatever is added later) must have built.
BUILT=0
for ADDON_OUT in "$ADDONS_OUT"/*/; do
  [ -f "$ADDON_OUT/index.js" ] || { echo "embed-daemon: the $(basename "$ADDON_OUT") add-on was not built" >&2; exit 1; }
  BUILT=$((BUILT + 1))
done
[ "$BUILT" -gt 0 ] || { echo "embed-daemon: no distributed add-on was built" >&2; exit 1; }
[ ! -e "$ADDONS_OUT/conductor-relay" ] || { echo "embed-daemon: the relay add-on is in the bundle" >&2; exit 1; }
[ -f "$STAGE/dist/squeak/cli.js" ] || { echo "embed-daemon: tsc produced no dist/squeak/cli.js" >&2; exit 1; }

# The pin src/native/agent-sdk-pin.ts must match package-lock.json: each Mac downloads exactly that tarball from npm.
(cd "$REPO" && "$REPO/node_modules/.bin/tsx" scripts/make-agent-sdk-pin.ts --check) \
  || { echo "embed-daemon: the Agent SDK pin is out of date" >&2; exit 1; }
# One bundle: everything is inlined (zod and the rest) except better-sqlite3, whose .node binary cannot be bundled, and
# Anthropic's Claude Agent SDK: Squeak does not redistribute it (all rights reserved), src/native/agent-sdk.ts
# downloads it from npm on the person's Mac.
# Files the daemon finds beside itself (agent-plugin, brand, cloud, VERSION, package.json) are two folders above
# dist/squeak, exactly as from the tsc layout, because the bundle keeps its own import.meta.url at dist/squeak/.
# The banner gives bundled CommonJS a `require`.
"$REPO/node_modules/.bin/esbuild" "$STAGE/dist/squeak/cli.js" --bundle --splitting --format=esm --platform=node \
  --target=node22 --outdir="$STAGE/bundle/squeak" --entry-names=cli --chunk-names='chunk-[hash]' \
  --external:better-sqlite3 --external:@anthropic-ai/claude-agent-sdk --legal-comments=none --log-level=warning \
  --banner:js='import{createRequire as __squeakCreateRequire}from"node:module";const require=__squeakCreateRequire(import.meta.url);'
# The SDK's code must not be in the app (strings only its code carries).
if grep -lE "CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS|CLAUDE_AGENT_SDK_MCP_NO_PREFIX" "$STAGE"/bundle/squeak/*.js | grep -q .; then
  echo "embed-daemon: Anthropic's Claude Agent SDK is inside the daemon bundle; Squeak must not redistribute it" >&2; exit 1
fi
# Anything else that resolves to a native module would fail at run time on a machine without a build: refuse it now.
if grep -lE "\.node['\"]" "$STAGE"/bundle/squeak/*.js | grep -q .; then
  echo "embed-daemon: the bundle references a .node file other than through better-sqlite3" >&2
  grep -nE "\.node['\"]" "$STAGE"/bundle/squeak/*.js | head -5 >&2; exit 1
fi
rm -rf "$STAGE/dist"
mkdir -p "$STAGE/dist"
mv "$STAGE/bundle/squeak" "$STAGE/dist/squeak"
mv "$ADDONS_OUT" "$STAGE/dist/addons"
[ ! -e "$STAGE/dist/addons/conductor-relay" ] || { echo "embed-daemon: the relay add-on is in the bundle" >&2; exit 1; }
rm -rf "$STAGE/bundle" "$STAGE/node_modules"

# Runtime dependencies: only the native, at the version the lockfile pins, installed with the bundled Node first on PATH
# so better-sqlite3 fetches (or builds) for its ABI. package.json keeps "type": "module" for dist/squeak/cli.js.
BSQ_VERSION="$("$NODE" -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(l.packages["node_modules/better-sqlite3"].version)' "$STAGE/package-lock.json")"
"$NODE" -e '
const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
p.dependencies={"better-sqlite3":process.argv[2]};delete p.devDependencies;delete p.scripts;
fs.writeFileSync(process.argv[1],JSON.stringify(p,null,2));' "$STAGE/package.json" "$BSQ_VERSION"
rm "$STAGE/package-lock.json"
(cd "$STAGE" && PATH="$NODE_ROOT/bin:$PATH" "$NODE_ROOT/bin/node" "$NODE_ROOT/lib/node_modules/npm/bin/npm-cli.js" install --omit=dev --ignore-scripts=false --no-audit --no-fund --no-package-lock --loglevel=error)

# better-sqlite3 loads only `bindings` (and its file-uri-to-path) at run time; prebuild-install and the rest of what
# npm fetched were for downloading the binary, which is done.
for d in "$STAGE"/node_modules/*; do
  case "$(basename "$d")" in better-sqlite3|bindings|file-uri-to-path) ;; *) rm -rf "$d" ;; esac
done
rm -f "$STAGE/node_modules/.package-lock.json"
rm -rf "$STAGE/node_modules/.bin"
# Prune what a running daemon never reads.
find "$STAGE/node_modules" \( -name '*.map' -o -name '*.md' -o -name '*.markdown' \) -type f -delete 2>/dev/null || true
find "$STAGE/node_modules" -type d \( -name test -o -name tests -o -name docs -o -name example -o -name examples -o -name .github \) -prune -exec rm -rf {} + 2>/dev/null || true
BSQ="$STAGE/node_modules/better-sqlite3"
if [ -d "$BSQ" ]; then
  rm -rf "$BSQ/deps" "$BSQ/src" "$BSQ/build/Release/obj" "$BSQ/build/Release/.deps" "$BSQ/build/deps" "$BSQ/build/Makefile" "$BSQ/build/config.gypi"
  find "$BSQ/build" -type f ! -name '*.node' -delete 2>/dev/null || true
fi

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
# The skills plugin Squeak gives its Claude chats (src/native/agent-plugin.ts looks for ../../agent-plugin).
rsync -a "$REPO/agent-plugin/" "$DEST/agent-plugin/"
# The Catalyst relay function (src/cloud/catalyst-setup.ts finds ../../cloud/catalyst-relay from dist/cloud): its
# source only; deploy() copies it to Application Support and installs its own node_modules there.
[ -d "$REPO/cloud/catalyst-relay" ] || { echo "embed-daemon: cloud/catalyst-relay is missing" >&2; exit 1; }
mkdir -p "$DEST/cloud"
rsync -a --exclude node_modules --exclude .catalystrc "$REPO/cloud/catalyst-relay/" "$DEST/cloud/catalyst-relay/"
printf '%s\n' "$DAEMON_VERSION" > "$DEST/VERSION"
[ ! -e "$DEST/node_modules/@anthropic-ai" ] || { echo "embed-daemon: an @anthropic-ai package is in the app's node_modules" >&2; exit 1; }
if grep -rlE "CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS|CLAUDE_AGENT_SDK_MCP_NO_PREFIX" "$DEST/dist" | grep -q .; then
  echo "embed-daemon: Anthropic's Claude Agent SDK is inside the embedded daemon" >&2; exit 1
fi

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
# Smoke: really start the bundled daemon (temp HOME and support dir, a spare port, everything optional off, so it never
# touches a live daemon) and wait for /state and startup.json to say it is up. Cold start is printed.
SMOKE_HOME="$WORK/smoke-home"; mkdir -p "$SMOKE_HOME"
SMOKE_PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
T0="$(python3 -c 'import time;print(time.time())')"
env -i HOME="$SMOKE_HOME" PATH=/usr/bin:/bin SQUEAK_ENV_PATH="$SMOKE_HOME/support/.env" SQUEAK_DB_PATH="$SMOKE_HOME/support/squeak.db" FLEET_HOOK_PORT="$SMOKE_PORT" \
  SQUEAK_REMOTE_LOCAL=off SQUEAK_CAFFEINATE=off SQUEAK_HANDS_APP=off SQUEAK_FLOTILLA=off SQUEAK_CORE=off \
  "$DEST/node" "$DEST/dist/squeak/cli.js" start >"$SMOKE_HOME/out.log" 2>&1 &
SMOKE_PID=$!
SMOKE_OK=0
for _ in $(seq 1 300); do
  if curl -fs "http://127.0.0.1:$SMOKE_PORT/state" >/dev/null 2>&1 \
    && grep -q '"phase":"ready"' "$SMOKE_HOME/support/startup.json" 2>/dev/null; then SMOKE_OK=1; break; fi
  kill -0 "$SMOKE_PID" 2>/dev/null || break
  sleep 0.2
done
SMOKE_SECS="$(python3 -c "import time;print(round(time.time()-$T0,1))")"
kill "$SMOKE_PID" 2>/dev/null || true; wait "$SMOKE_PID" 2>/dev/null || true
if [ "$SMOKE_OK" != 1 ]; then
  echo "embed-daemon: smoke failed: the bundled daemon did not answer /state (log and startup.json follow)" >&2
  cat "$SMOKE_HOME/out.log" "$SMOKE_HOME/support/startup.json" >&2 2>/dev/null || true; exit 1
fi
echo "Smoke: bundled daemon answered /state and reported ready in ${SMOKE_SECS}s"
echo "Embedded daemon $DAEMON_VERSION ($(du -sh "$DEST" | cut -f1)) in $DEST"
