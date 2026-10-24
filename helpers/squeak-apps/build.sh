#!/bin/sh
# Build squeak-apps (main.swift). Usage: build.sh <output-dir>. The Mac app bundles it; no permission needed.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:?output dir}"
mkdir -p "$out"
swiftc -O -target arm64-apple-macos14 -o "$out/squeak-apps" "$here/main.swift" -framework AppKit
echo "$out/squeak-apps"
