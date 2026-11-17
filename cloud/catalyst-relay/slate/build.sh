#!/usr/bin/env bash
# Stage the web app for Slate (https://squeak.onslate.in): the same client the legacy web client hosting serves, assembled by
# scripts/build-guest-client.sh, plus .catalyst/slate-config.toml and the SPA fallback. Slate serves from "/" (index.html is
# the entry page and loads js/ and css/ by relative path), so nothing in the client changes. Sign-in on this origin goes
# through the relay's /account/handoff on the function origin (web/js/catalyst-session.js), so no relay origin is baked in.
#   slate/build.sh [outdir]    default slate/build (git-ignored)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
OUT="${1:-$HERE/build}"
rm -rf "$OUT"; mkdir -p "$OUT/.catalyst"
"$ROOT/scripts/build-guest-client.sh" "$OUT" >/dev/null
rm -f "$OUT/client-package.json"
cp "$HERE/slate-config.toml" "$OUT/.catalyst/slate-config.toml"
printf '/* /index.html 200\n' > "$OUT/_redirects"
# Slate's static hosting ignores _redirects (and slate-config [[redirects]]): an unknown path is a 404. The emailed invite
# link is /join#<code>, so /join gets a real copy of the entry page; <base href="/"> keeps its relative js/ and css/ paths.
mkdir -p "$OUT/join"
sed 's#<head>#<head>\n    <base href="/" />#' "$OUT/index.html" > "$OUT/join/index.html"
grep -q '<base href="/"' "$OUT/join/index.html" || { echo "join/index.html: no <base>"; exit 1; }
echo "staged $OUT"
