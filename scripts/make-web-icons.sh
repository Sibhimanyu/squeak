#!/usr/bin/env bash
# Squeak for Web's home-screen icons, from the brand duck (never redrawn):
# the full duck at 65% of the canvas on Ink, as DESIGN.md's app icon (maskable
# at 52%, inside the safe zone). Output: web/assets/. macOS only (sips).
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=brand/logo/png/squeak-duck-full-color-1024.png
INK=18191B
make() { # name size percent
  local out="web/assets/$1" size=$2 w=$(($2 * $3 / 100))
  sips -s format png -Z "$w" "$SRC" --out "$out" >/dev/null
  sips --padToHeightWidth "$size" "$size" --padColor "$INK" "$out" >/dev/null
}
make apple-touch-icon.png 180 65
make icon-192.png 192 65
make icon-512.png 512 65
make icon-maskable-512.png 512 52
