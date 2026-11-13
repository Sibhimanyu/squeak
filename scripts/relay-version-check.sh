#!/usr/bin/env bash
# Preflight for ship.sh and release-mac.sh: is Squeak's hosted cloud relay at least the version this build needs?
#
#   scripts/relay-version-check.sh <path to cloud/catalyst-relay/functions/squeak_relay/package.json>
#
# Required = that package.json's version. Deployed = catalyst.deployedVersion in <support dir>/cloud.json (the
# relay's /ping carries a version too, but it needs a key, so there is no unauthenticated route to ask).
# Exit 0: fine, or unknown (a warning). Exit 1: the relay is older than the build needs.
set -euo pipefail
PKG="${1:-}"
SUPPORT="${SQUEAK_SUPPORT_DIR:-$HOME/Library/Application Support/squeak}"
[ -f "$PKG" ] || { echo "relay check: no relay package.json at '$PKG'; skipping" >&2; exit 0; }
RELAY_PKG="$PKG" CLOUD="$SUPPORT/cloud.json" node - <<'JS'
const fs = require("fs");
const req = JSON.parse(fs.readFileSync(process.env.RELAY_PKG, "utf8")).version;
let dep = null;
try { dep = (JSON.parse(fs.readFileSync(process.env.CLOUD, "utf8")).catalyst || {}).deployedVersion || null; } catch {}
if (!dep) {
  console.error("warning: Squeak cloud relay version unknown (no catalyst.deployedVersion in cloud.json); this build needs " + req + ". Continuing.");
  process.exit(0);
}
const n = (v) => String(v).split("-")[0].split(".").map((x) => parseInt(x, 10) || 0);
const a = n(dep), b = n(req);
for (let i = 0; i < 3; i++) {
  if ((a[i] || 0) < (b[i] || 0)) {
    console.error("Squeak's cloud relay is " + dep + ", this build needs " + req + ". Deploy it first: cloud/catalyst-relay/deploy-hosted.sh \u2014 then rerun. (Override: --skip-relay-check)");
    process.exit(1);
  }
  if ((a[i] || 0) > (b[i] || 0)) break;
}
JS
