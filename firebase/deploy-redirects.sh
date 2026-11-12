#!/usr/bin/env bash
# The last Firebase Hosting deploy: squeak-mac.web.app only forwards to Squeak for Web on Catalyst (redirects/web), and
# squeak-5c9gvo.web.app keeps source.json/icon.png for phones still subscribed to the old SideStore source, forwards
# /open/ to GitHub Pages (redirects/main/open) and links / to the new iOS page. Hosting only: never rules or database.
# Firebase Hosting is otherwise retired; disable both sites after 2027-02-12.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf public web-public
mkdir -p public/open web-public
cp redirects/main/open/index.html public/open/
cp redirects/web/index.html redirects/web/redirect.js web-public/
for f in source.json icon.png index.html; do curl -fsS -o "public/$f" "https://squeak-5c9gvo.web.app/$f"; done
grep -q "sibhimanyu.github.io/squeak/ios/" public/index.html
firebase deploy --only hosting -m "redirect-only: Squeak for Web moved to Catalyst"
