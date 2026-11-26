#!/usr/bin/env bash
# The last Firebase Hosting deploy: squeak-mac.web.app only forwards (every path, /join included, invite codes kept) to Squeak for Web at squeak.onslate.in (cloud/catalyst-relay/client, the same page Catalyst serves at /app/index.html), and
# squeak-5c9gvo.web.app keeps source.json/icon.png for phones still subscribed to the old SideStore source, forwards
# /open/ to GitHub Pages (redirects/main/open) and links / to the new iOS page. Hosting only: never rules or database.
# Firebase Hosting is otherwise retired; disable both sites after 2027-02-12.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf public web-public
mkdir -p public/open web-public
cp redirects/main/open/index.html public/open/
cp ../cloud/catalyst-relay/client/index.html ../cloud/catalyst-relay/client/redirect.js web-public/
for f in source.json icon.png index.html; do curl -fsS -o "public/$f" "https://squeak-5c9gvo.web.app/$f"; done
grep -q "sibhimanyu.github.io/squeak/ios/" public/index.html
firebase deploy --only hosting -m "redirect-only: Squeak for Web moved to Catalyst"
