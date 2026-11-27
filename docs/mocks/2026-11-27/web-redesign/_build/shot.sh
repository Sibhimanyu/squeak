#!/bin/bash
# Renders every mock headless (no window is shown). Wide: 1440x900 at 1.5x; phone: 390x844 at 2x.
set -e
cd "$(dirname "$0")/.."
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
python3 _build/gen.py
for d in a b c; do
  for f in $d/*.html; do
    n="${f%.html}"
    case "$n" in
      *phone*) W=390; H=844; S=2 ;;
      *) W=1440; H=900; S=1.5 ;;
    esac
    "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=$S \
      --window-size=$W,$H --virtual-time-budget=3000 --screenshot="$PWD/$n.png" "file://$PWD/$f" >/dev/null 2>&1
    echo "$n.png"
  done
done
