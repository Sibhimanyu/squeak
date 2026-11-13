#!/usr/bin/env bash
# Stage the AppSail bundle into appsail/build (git-ignored): the function's own modules, unchanged, plus server.js.
# One copy of the rules during the dual-run: nothing under functions/squeak_relay is edited or duplicated in git.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FN="$HERE/../functions/squeak_relay"
OUT="${1:-$HERE/build}"
rm -rf "$OUT"; mkdir -p "$OUT"
for f in index.js handler.js rules.js scoped.js tenants.js kinds.json package.json; do cp "$FN/$f" "$OUT/$f"; done
cp "$HERE/server.js" "$OUT/server.js"
# server.js is the entry; the function's package.json supplies version + the three @zcatalyst deps.
node -e '
const fs=require("fs"),p=process.argv[1]+"/package.json",j=JSON.parse(fs.readFileSync(p,"utf8"));
j.main="server.js"; j.engines={node:">=22"}; j.scripts={start:"node server.js"};
fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");' "$OUT"
(cd "$OUT" && npm install --omit=dev --no-audit --no-fund >/dev/null)
echo "staged $OUT"
