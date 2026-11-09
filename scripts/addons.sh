#!/usr/bin/env bash
# Build or type-check the add-ons that are present (addons/<name>/ with a tsconfig.json). With none, it does nothing.
#   scripts/addons.sh build   compile each to dist/addons/<name>/ (index.js beside the built daemon)
#   scripts/addons.sh check   type-check each, tests and scripts included
# The compile also emits the core files an add-on takes types from, so it goes to dist/.addon-build and only the
# add-on's own folder is kept.
set -euo pipefail
cd "$(dirname "$0")/.."
mode="${1:-}"
# Where builds go: dist (npm run build) or ship.sh's dist.new, so a ship never writes into the live dist.
out="${ADDONS_DIST:-dist}"
case "$mode" in build | check) ;; *) echo "usage: scripts/addons.sh build|check" >&2; exit 2 ;; esac
for dir in addons/*/; do
  name="$(basename "$dir")"
  [ -f "$dir/tsconfig.json" ] || continue
  if [ "$mode" = check ]; then
    npx tsc -p "$dir/tsconfig.json"
  else
    npx tsc -p "$dir/tsconfig.build.json" --outDir "$out/.addon-build/$name"
    rm -rf "$out/addons/$name"
    mkdir -p "$out/addons"
    mv "$out/.addon-build/$name/addons/$name" "$out/addons/$name"
    rm -rf "$out/.addon-build"
  fi
done
exit 0
