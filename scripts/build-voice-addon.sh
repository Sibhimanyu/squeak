#!/usr/bin/env bash
# Builds the Home Assistant add-on folder: homeassistant/squeak-voice plus the bundled gateway.
# Copy the printed folder to Home Assistant's /addons share (Samba or SSH add-on), then
# Settings > Add-ons > Add-on store > (menu) Check for updates > Local add-ons > Squeak Voice.
set -euo pipefail
cd "$(dirname "$0")/.."
out="dist-addon/squeak-voice"
rm -rf "$out"
mkdir -p "$out"
cp homeassistant/squeak-voice/{config.yaml,Dockerfile,run.sh,DOCS.md} "$out/"
npx esbuild src/voice/gateway-entry.ts --bundle --platform=node --format=esm --target=node22 \
  --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
  --outfile="$out/gateway.mjs" --log-level=warning
echo "Add-on folder: $PWD/$out"
