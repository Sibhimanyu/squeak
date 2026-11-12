#!/usr/bin/env bash
# Build or type-check the add-ons that are present (addons/<name>/ with a tsconfig.json). With none, it does nothing.
#   scripts/addons.sh build   bundle each to dist/addons/<name>/ (index.js and addon.json beside the built daemon)
#   scripts/addons.sh check   type-check each, tests and scripts included
# Each add-on is one self-contained esbuild bundle (everything it takes from core is inlined; only better-sqlite3 stays
# external), so the same file runs from the tsc layout (dist/) and from the embedded daemon (dist/squeak/cli.js).
# ADDONS_ONLY="a b" limits the build to those names.
set -euo pipefail
cd "$(dirname "$0")/.."
mode="${1:-}"
# Where builds go: dist (npm run build) or ship.sh's dist.new, so a ship never writes into the live dist.
out="${ADDONS_DIST:-dist}"
case "$mode" in build | check) ;; *) echo "usage: scripts/addons.sh build|check" >&2; exit 2 ;; esac
for dir in addons/*/; do
  name="$(basename "$dir")"
  [ -f "$dir/tsconfig.json" ] || continue
  if [ -n "${ADDONS_ONLY:-}" ] && [[ " $ADDONS_ONLY " != *" $name "* ]]; then continue; fi
  if [ "$mode" = check ]; then
    npx tsc -p "$dir/tsconfig.json"
  else
    [ -f "$dir/addon.json" ] || { echo "addons.sh: $dir has no addon.json" >&2; exit 1; }
    rm -rf "$out/addons/$name"
    mkdir -p "$out/addons/$name"
    npx esbuild "$dir/index.ts" --bundle --platform=node --format=esm --target=node22 \
      --external:better-sqlite3 --log-level=warning --legal-comments=none \
      --banner:js='import{createRequire as __squeakCreateRequire}from"node:module";const require=__squeakCreateRequire(import.meta.url);' \
      --outfile="$out/addons/$name/index.js"
    cp "$dir/addon.json" "$out/addons/$name/addon.json"
  fi
done
exit 0
