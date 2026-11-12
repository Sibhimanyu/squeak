#!/usr/bin/env bash
# Deploy the hand-written pages (firebase/pages) to the channel's Hosting site,
# alongside whatever the iPhone release last put in public/.
echo "Firebase Hosting is retired (squeak-mac redirects to Catalyst, squeak-5c9gvo is frozen); nothing deployed. See deploy-redirects.sh." >&2
exit 0
cd "$(dirname "$0")"
mkdir -p public
cp -R pages/. public/
./stage-web.sh
firebase deploy --only hosting -m "pages"
