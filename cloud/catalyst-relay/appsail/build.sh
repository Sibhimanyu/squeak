#!/usr/bin/env bash
# Stage the AppSail bundle into appsail/build (git-ignored): the function's own modules, unchanged, plus server.js.
# One copy of the rules during the dual-run: nothing under functions/squeak_relay is edited or duplicated in git.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FN="$HERE/../functions/squeak_relay"
OUT="${1:-$HERE/build}"
rm -rf "$OUT"; mkdir -p "$OUT"
# Every module the function has (a fixed list here once missed channels-cache.js and the app could not start), and its
# package.json; never the function's own catalyst-config.json or lockfile.
for f in "$FN"/*.js "$FN"/kinds.json "$FN"/people-schema.json "$FN"/package.json; do cp "$f" "$OUT/$(basename "$f")"; done
cp "$HERE/server.js" "$OUT/server.js"
# server.js is the entry; the function's package.json supplies version + the three @zcatalyst deps.
node -e '
const fs=require("fs"),p=process.argv[1]+"/package.json",j=JSON.parse(fs.readFileSync(p,"utf8"));
j.main="server.js"; j.engines={node:">=22"}; j.scripts={start:"node server.js"};
fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");' "$OUT"
(cd "$OUT" && npm install --omit=dev --no-audit --no-fund >/dev/null)
# The bundle must load: a missing module fails here, not as a 503 after deploy.
(cd "$OUT" && node -e 'require("./index.js"); require("./server.js")') || { echo "staged bundle does not load"; exit 1; }
echo "staged $OUT"
