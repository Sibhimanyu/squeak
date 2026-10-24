#!/bin/sh
# Build squeak-fans (main.c). Usage: build.sh <output-dir>
# A universal binary: the Mac app embeds it, and installs it root-owned for fan control.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:?output dir}"
mkdir -p "$out"
clang -O2 -Wall -Werror -arch arm64 -arch x86_64 -mmacosx-version-min=14.0 \
  -framework IOKit -framework CoreFoundation -framework ApplicationServices -o "$out/squeak-fans" "$here/main.c"
echo "$out/squeak-fans"
