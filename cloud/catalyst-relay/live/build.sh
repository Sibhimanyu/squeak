#!/usr/bin/env bash
# Stage the squeak-live bundle into live/build (git-ignored): the relay's modules it shares (scoped, tenants, people, the SDK wiring in
# index.js) unchanged, plus this folder's hub, fan-out and server. Nothing under functions/squeak_relay is copied into git.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FN="$HERE/../functions/squeak_relay"
OUT="${1:-$HERE/build}"
rm -rf "$OUT"; mkdir -p "$OUT"
for f in "$FN"/*.js "$FN"/kinds.json "$FN"/people-schema.json "$FN"/package.json; do cp "$f" "$OUT/$(basename "$f")"; done
for f in hub.js fanout.js server.js; do cp "$HERE/$f" "$OUT/$f"; done
node -e '
const fs=require("fs"),p=process.argv[1]+"/package.json",j=JSON.parse(fs.readFileSync(p,"utf8"));
j.name="squeak-live"; j.main="server.js"; j.engines={node:">=22"}; j.scripts={start:"node server.js"};
fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");' "$OUT"
(cd "$OUT" && npm install --omit=dev --no-audit --no-fund >/dev/null)
(cd "$OUT" && node -e 'require("./hub.js"); require("./fanout.js"); require("./server.js"); require("./index.js")') || { echo "staged bundle does not load"; exit 1; }
echo "staged $OUT"
