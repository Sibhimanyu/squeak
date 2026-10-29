#!/usr/bin/env bash
# Copy Squeak for Web (web/) into its own Hosting site's folder, web-public/,
# served at the root of squeak-mac.web.app. Only what the browser loads: never
# the tests. Run by deploy-pages.sh and the iPhone release, both of which
# deploy every Hosting site.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf web-public
mkdir -p web-public
cp ../web/index.html ../web/manifest.webmanifest web-public/
cp -R ../web/js ../web/css ../web/assets web-public/
