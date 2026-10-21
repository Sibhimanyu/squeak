#!/usr/bin/env bash
# Deploy the hand-written pages (firebase/pages) to the channel's Hosting site,
# alongside whatever the iPhone release last put in public/.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p public
cp -R pages/. public/
./stage-web.sh
firebase deploy --only hosting -m "pages"
