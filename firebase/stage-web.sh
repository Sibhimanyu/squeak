#!/usr/bin/env bash
# Copy Squeak for Web (web/) into the Hosting folder as /app/. Only what the
# browser loads: never the tests. Run by deploy-pages.sh and the iPhone
# release, both of which publish the whole of public/.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf public/app
mkdir -p public/app
cp ../web/index.html public/app/
cp -R ../web/js ../web/css ../web/assets public/app/
