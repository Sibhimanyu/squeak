#!/bin/sh
# Build squeak-decider. Usage: build.sh <output-dir>. The Mac app bundles it; no permission needed.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:?output dir}"
mkdir -p "$out"
cd "$here"
swift build -c release --arch arm64 >&2
cp "$(swift build -c release --arch arm64 --show-bin-path)/squeak-decider" "$out/squeak-decider"
echo "$out/squeak-decider"
