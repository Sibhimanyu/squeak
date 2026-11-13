#!/usr/bin/env bash
# Stage the web app for Slate: slate/build/ = client/ (minus client-package.json routing) + .catalyst/slate-config.toml.
# Slate serves from "/" not "/app/": index.html and join.html land at the root; RELAY_ORIGIN is baked into config.js.
#   RELAY_ORIGIN  https://<relay host> (AppSail, or a custom domain). Required.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/build}"
: "${RELAY_ORIGIN:?set RELAY_ORIGIN to the AppSail relay origin}"
rm -rf "$OUT"; mkdir -p "$OUT/.catalyst"
cp -R "$HERE/../client/." "$OUT/"
cp "$HERE/slate-config.toml" "$OUT/.catalyst/slate-config.toml"
printf '/* /index.html 200\n' > "$OUT/_redirects"
echo "window.SQUEAK_RELAY_ORIGIN=${RELAY_ORIGIN@Q};" > "$OUT/relay-origin.js"
echo "staged $OUT (add <script src=\"/relay-origin.js\"> and use SQUEAK_RELAY_ORIGIN in catalyst-session.js: client change, see PLAN)"
