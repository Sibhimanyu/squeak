#!/usr/bin/env bash
# Operator-only: deploy the relay as Squeak's HOSTED relay (Catalyst project "squeak", Development environment).
# Copies cloud/catalyst-relay to a temp dir, fills the function's env, deploys functions only, cleans up.
#
#   RELAY_KEY                  default: the relay key already in ~/Library/Application Support/squeak/cloud.json
#                              (catalyst block), so the current Mac keeps working
#   SQUEAK_ZOHO_CLIENT_ID/SECRET  optional; left as the REPLACED_AT_DEPLOY placeholder (= unset) when absent
#   SQUEAK_CLIQ_KEY            default: SQUEAK_CLIQ_KEY in <support dir>/.env; becomes the function's CLIQ_KEY (never printed).
#                              Without it CLIQ_KEY stays UNSET and Cliq's handlers get a 401.
#   SQUEAK_CATALYST_PROJECT_ID    default 53069000000381140 (project "squeak")
# Secrets are only read from the environment / cloud.json and written into the temp copy; never printed.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
SUPPORT="${SQUEAK_SUPPORT_DIR:-$HOME/Library/Application Support/squeak}"
PROJECT_ID="${SQUEAK_CATALYST_PROJECT_ID:-53069000000381140}"

command -v catalyst >/dev/null || { echo "catalyst CLI not found (npm i -g zcatalyst-cli)"; exit 1; }
catalyst whoami >/dev/null 2>&1 || { echo "Not signed in: run 'catalyst login'"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
tar -C "$SRC" --exclude=node_modules --exclude=test --exclude=deploy-hosted.sh -cf - . | tar -C "$TMP" -xf -
chmod 700 "$TMP"

if [ -f "$SUPPORT/catalyst-relay/.catalystrc" ]; then
  cp "$SUPPORT/catalyst-relay/.catalystrc" "$TMP/.catalystrc"
else
  (cd "$TMP" && catalyst init -p "$PROJECT_ID" -ni >/dev/null)
fi

FN="$TMP/functions/squeak_relay"
SUPPORT="$SUPPORT" FN="$FN" node -e '
const fs = require("fs"), path = require("path");
const p = path.join(process.env.FN, "catalyst-config.json");
const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
let key = process.env.RELAY_KEY;
if (!key) {
  const cloud = JSON.parse(fs.readFileSync(path.join(process.env.SUPPORT, "cloud.json"), "utf8"));
  key = cloud.catalyst && cloud.catalyst.relayKey;
}
if (!key) { console.error("No RELAY_KEY in env or cloud.json"); process.exit(1); }
let cliqKey = process.env.SQUEAK_CLIQ_KEY;
if (!cliqKey) {
  try {
    const line = fs.readFileSync(path.join(process.env.SUPPORT, ".env"), "utf8").split(/\r?\n/)
      .find((l) => /^\s*SQUEAK_CLIQ_KEY\s*=/.test(l));
    cliqKey = line && line.slice(line.indexOf("=") + 1).trim().replace(/^(["\x27])(.*)\1$/, "$2");
  } catch {}
}
const e = cfg.deployment.env_variables;
if (cliqKey) e.CLIQ_KEY = cliqKey;
else console.error("Note: no SQUEAK_CLIQ_KEY in env or .env; CLIQ_KEY stays UNSET (Cliq handlers get 401).");
e.RELAY_KEY = key;
e.SQUEAK_RELAY_HOSTED = "1";
if (process.env.SQUEAK_ZOHO_CLIENT_ID) e.SQUEAK_ZOHO_CLIENT_ID = process.env.SQUEAK_ZOHO_CLIENT_ID;
if (process.env.SQUEAK_ZOHO_CLIENT_SECRET) e.SQUEAK_ZOHO_CLIENT_SECRET = process.env.SQUEAK_ZOHO_CLIENT_SECRET;
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
'

(cd "$FN" && if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi) >/dev/null
(cd "$TMP" && catalyst deploy --only functions:squeak_relay -ni)
echo "Deployed squeak_relay (hosted) to project $PROJECT_ID, Development."
# Record what is now deployed, so ship.sh / release-mac.sh can tell the relay is current.
SUPPORT="$SUPPORT" PKG="$SRC/functions/squeak_relay/package.json" node -e '
const fs = require("fs"), path = require("path");
const v = JSON.parse(fs.readFileSync(process.env.PKG, "utf8")).version;
const p = path.join(process.env.SUPPORT, "cloud.json");
try {
  const cloud = JSON.parse(fs.readFileSync(p, "utf8"));
  if (cloud.catalyst && cloud.catalyst.deployedVersion !== v) {
    cloud.catalyst.deployedVersion = v;
    fs.writeFileSync(p, JSON.stringify(cloud, null, 2) + "\n", { mode: 0o600 });
    console.log("cloud.json deployedVersion = " + v);
  }
} catch (e) { console.error("Could not update cloud.json deployedVersion: " + e.message); }
'
