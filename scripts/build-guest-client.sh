#!/usr/bin/env bash
# Assemble the web client as Catalyst web client hosting's folder: cloud/catalyst-relay/client/ (or $1), which
# `catalyst deploy` serves at <app domain>/app/ from the same domain as the relay (/server/squeak_relay), so the page
# reaches the relay by a same-origin path. Only what the page loads: join.html, its CSS, the duck, and the files
# guest-boot.js imports (found by following its imports, so a new import is picked up without editing this script).
# Never deploys. client-package.json stays where it is, in git; everything else here is generated and ignored.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/cloud/catalyst-relay/client}"
mkdir -p "$out/js" "$out/css" "$out/assets"
find "$out" -type f ! -name client-package.json -delete

cp "$root/web/join.html" "$out/join.html"
cp "$root/web/css/tokens.css" "$root/web/css/guest.css" "$root/web/css/app.css" "$root/web/css/shell.css" "$root/web/css/chat.css" "$root/web/css/welcome.css" "$out/css/"
cp "$root/web/assets/squeak-duck.svg" "$out/assets/"

WEB="$root/web" OUT="$out" node --input-type=module -e '
import fs from "node:fs";
import path from "node:path";
const web = process.env.WEB;
const out = process.env.OUT;
const seen = new Set();
const visit = (file) => {
  if (seen.has(file)) return;
  seen.add(file);
  // Comment lines can mention an import in prose (router.js does): only code counts.
  const source = fs.readFileSync(path.join(web, "js", file), "utf8").replace(/^\s*\/\/.*$/gm, "");
  for (const m of source.matchAll(/(?:from|import)\s*\(?\s*"\.\/([^"]+\.js)"/g)) visit(m[1]);
};
visit("entry.js");
visit("guest-boot.js");
visit("app.js");
for (const file of seen) {
  fs.mkdirSync(path.dirname(path.join(out, "js", file)), { recursive: true });
  fs.copyFileSync(path.join(web, "js", file), path.join(out, "js", file));
}
'

# index.html is the entry (web/entry.html + js/entry.js): Catalyst's client hosting answers 200 only for index.html (other
# pages come back with a 404 status, which a link preview may refuse), so invite links and the owner app both open
# /app/index.html, and entry.js loads the guest page (an invite fragment, or a guest's own records) or the owner app
# (a #pair= fragment, a stored device, or nothing). join.html stays in the folder for older links' sake.
cp "$root/web/entry.html" "$out/index.html"
echo "client assembled in $out"
