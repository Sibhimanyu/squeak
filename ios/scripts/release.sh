#!/usr/bin/env bash
# Build a Release .ipa and publish it as a SideStore source. The .ipa is an asset of a GitHub Release
# (ios-v<version> on Sibhimanyu/squeak); the source (source.json, icon.png, index.html) and the "Open in
# Squeak" page go to https://sibhimanyu.github.io/squeak/ios/ and /open/ through macos/scripts/publish-pages.sh
# (Git Data API, only those named paths, no clone of the Pages repo). Phones add
# https://sibhimanyu.github.io/squeak/ios/source.json in SideStore and get updates there.
#
#   ./scripts/release.sh "What changed, one line"          # build + publish
#   ./scripts/release.sh "..." --no-deploy                  # build only
#   ./scripts/release.sh "..." --dry-run                    # print the plan, build and publish nothing
#   ./scripts/release.sh "..." --no-firebase                # skip the transition deploy to the old Firebase source
#
# Transition (--also-firebase, on by default while it is needed, and only if the firebase CLI is installed):
# the same new source.json, pointing at the GitHub asset, is also deployed to the old Firebase Hosting site, so
# phones still subscribed to https://squeak-5c9gvo.web.app/source.json receive this build.
#
# The marketing version is MARKETING_VERSION in project.yml: SideStore
# compares marketing versions, not build numbers, so bump it for a release
# to reach phones. The build number is a UTC timestamp.
set -euo pipefail
cd "$(dirname "$0")/.."

NOTES="${1:?usage: release.sh \"release notes\" [--no-deploy] [--dry-run] [--no-firebase]}"
shift
DEPLOY=1; DRY=0; ALSO_FIREBASE=1
for arg in "$@"; do
  case "$arg" in
    --no-deploy) DEPLOY=0 ;;
    --dry-run) DRY=1 ;;
    --also-firebase) ALSO_FIREBASE=1 ;;
    --no-firebase) ALSO_FIREBASE=0 ;;
    *) echo "unknown option $arg" >&2; exit 2 ;;
  esac
done

PROJECT="$(python3 -c "import json; print(json.load(open('../firebase/.firebaserc'))['projects']['default'])")"
OLD_SITE="https://$PROJECT.web.app"
SITE="https://sibhimanyu.github.io/squeak/ios"
OPEN_PAGE="https://sibhimanyu.github.io/squeak/open/"
REPO="Sibhimanyu/squeak"
PUBLIC="../firebase/public"
OUT="build/pages-ios" # what goes to Pages: source.json, icon.png, index.html
BUNDLE="$(sed -n 's/^SQUEAK_BUNDLE_ID *= *//p' Config/App.xcconfig)"
VERSION="$(sed -n 's/^ *MARKETING_VERSION: *"\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' project.yml)"
BUILD="$(date -u +%Y%m%d%H%M)"
TAG="ios-v$VERSION"
IPA="Squeak-$VERSION-$BUILD.ipa"
ASSET_URL="https://github.com/$REPO/releases/download/$TAG/$IPA"

live_version() { curl -fsS "$1/source.json" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['apps'][0]['version'])" 2>/dev/null || true; }
# The new source is the gate; before its first publish, the old Firebase one stands in.
LIVE="$(live_version "$SITE")"; [[ -n "$LIVE" ]] || LIVE="$(live_version "$OLD_SITE")"
if [[ -n "$LIVE" && $DEPLOY == 1 ]]; then
  python3 - "$VERSION" "$LIVE" <<'PY' || { echo "MARKETING_VERSION $VERSION is not newer than the live $LIVE — bump it in project.yml, or SideStore will never offer this build." >&2; [[ $DRY == 1 ]] || exit 1; }
import sys
v = lambda s: tuple(int(x) for x in s.split("."))
sys.exit(0 if v(sys.argv[1]) > v(sys.argv[2]) else 1)
PY
fi

echo "==> Squeak $VERSION ($BUILD)"
HAVE_FIREBASE=0; command -v firebase >/dev/null 2>&1 && HAVE_FIREBASE=1
if [[ $DRY == 1 ]]; then
  echo "dry run: nothing is built or published. Live version: ${LIVE:-none}"
  echo "  1. build the Release .ipa (xcodebuild) as $IPA"
  echo "  2. GitHub Release $TAG on $REPO: upload $IPA (--clobber)"
  echo "     asset URL: $ASSET_URL"
  echo "  3. publish to sibhimanyu.github.io via publish-pages.sh --files (only these paths):"
  echo "       squeak/ios/source.json  squeak/ios/icon.png  squeak/ios/index.html  squeak/open/index.html"
  echo "     source: $SITE/source.json   open page: $OPEN_PAGE"
  if [[ $ALSO_FIREBASE == 1 && $HAVE_FIREBASE == 1 ]]; then
    echo "  4. transition: stage the same source.json in firebase/public and deploy Hosting to $PROJECT"
  else
    echo "  4. transition deploy to Firebase: skipped (flag off or firebase CLI missing)"
  fi
  exit 0
fi
(cd SqueakCore && swift test >/dev/null 2>&1) || { echo "SqueakCore tests failed — run swift test in SqueakCore" >&2; exit 1; }
xcodegen -q
rm -rf build/Release-iphoneos build/ipa build/Build/Products/Release-iphoneos
# Trust xcodebuild's own exit code, not a grep for "error:" — benign tool
# noise (e.g. a CoreSimulator "...DeveloperDir:error:..." warning) contains
# that substring and used to fail the release even when the build succeeded.
mkdir -p build
set +e
xcodebuild -project Squeak.xcodeproj -scheme Squeak -configuration Release -sdk iphoneos \
  -destination 'generic/platform=iOS' -derivedDataPath build \
  CURRENT_PROJECT_VERSION="$BUILD" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  build -quiet >build/xcodebuild.log 2>&1
xcb_status=$?
set -e
if [[ $xcb_status -ne 0 ]]; then
  grep -iE "error:|BUILD FAILED" build/xcodebuild.log | grep -vi "SimServiceContext" | tail -20 >&2
  echo "xcodebuild failed (exit $xcb_status)" >&2
  exit 1
fi

APP="build/Build/Products/Release-iphoneos/Squeak.app"
[[ -d "$APP" ]] || { echo "build produced no app" >&2; exit 1; }

# What must and must not be inside anything published to a public URL.
check() { if eval "$2"; then :; else echo "release check failed: $1" >&2; exit 1; fi; }
check "build number stamped"          '[[ "$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$APP/Info.plist")" == "$BUILD" ]]'
check "camera purpose string present" '/usr/libexec/PlistBuddy -c "Print :NSCameraUsageDescription" "$APP/Info.plist" >/dev/null'
check "no pairing secrets bundled"    '! grep -rqa "squeak://pair?d=eyJ" "$APP"'
check "no service account bundled"    '! find "$APP" -iname "*adminsdk*" -o -iname "serviceAccount*.json" | grep -q .'

mkdir -p build/ipa/Payload
cp -R "$APP" build/ipa/Payload/
# A plain .ipa: it is a GitHub Release asset, which has no "executable upload" restriction.
mkdir -p "$OUT"; rm -f "$OUT"/*
rm -f build/*.ipa
(cd build/ipa && COPYFILE_DISABLE=1 zip -qry "../$IPA" Payload)
SIZE=$(stat -f%z "build/$IPA")
SHA=$(shasum -a 256 "build/$IPA" | cut -d' ' -f1)
cp Squeak/Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png "$OUT/icon.png"

python3 - "$VERSION" "$BUILD" "$NOTES" "$ASSET_URL" "$SIZE" "$SHA" "$BUNDLE" "$SITE" "$OUT" <<'PY'
import json, sys, datetime
version, build, notes, url, size, sha, bundle, site, out = sys.argv[1:]
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
v = {"version": version, "buildVersion": build, "date": now, "localizedDescription": notes,
     "downloadURL": url, "size": int(size), "sha256": sha, "minOSVersion": "18.0"}
source = {
  "name": "Squeak", "identifier": "com.squeak.source",
  "subtitle": "Your coding agents, in your pocket", "website": site + "/",
  "iconURL": f"{site}/icon.png", "tintColor": "#FCD02C",
  "apps": [{
    "name": "Squeak", "bundleIdentifier": bundle, "developerName": "Squeak",
    "subtitle": "Answer your agents from anywhere", "localizedDescription":
      "See every coding agent running on your Mac, read what it said, and answer its questions. Pairs with Squeak for Mac; replies are end-to-end encrypted and signed by this phone's Secure Enclave.",
    "iconURL": f"{site}/icon.png", "tintColor": "#FCD02C", "category": "developer",
    "version": version, "versionDate": now, "versionDescription": notes,
    "downloadURL": url, "size": int(size),
    "versions": [v], "appPermissions": {"entitlements": [], "privacy": {
      "NSCameraUsageDescription": "Squeak uses the camera once, to scan the pairing code on your Mac.",
      "NSFaceIDUsageDescription": "Squeak asks for Face ID before it sends anything to your agents."}},
  }],
  "news": [],
}
json.dump(source, open(f"{out}/source.json", "w"), indent=2)
PY

cat > "$OUT/index.html" <<HTML
<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"><title>Squeak for iPhone</title>
<style>
body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0;background:#09090b;color:#f4f4f5}
main{max-width:520px;margin:0 auto;padding:40px 20px}
img{width:72px;height:72px;border-radius:16px}
h1{font-size:28px;margin:16px 0 4px}p{color:#a1a1aa}
a.btn{display:block;text-align:center;padding:14px;border-radius:8px;background:#fcd02c;color:#18181b;
font-weight:600;text-decoration:none;margin:20px 0 10px}
a.alt{display:block;text-align:center;color:#f4f4f5;padding:10px}
code{background:#18181b;border:1px solid #27272a;border-radius:6px;padding:2px 6px;word-break:break-all}
</style></head><body><main>
<img src="$SITE/icon.png" alt=""><h1>Squeak for iPhone</h1>
<p>Version $VERSION ($BUILD). $(printf '%s' "$NOTES" | sed 's/&/\&amp;/g; s/</\&lt;/g')</p>
<p>Squeak for iPhone is installed with SideStore. Install SideStore on the phone first, then add the Squeak source in it.</p>
<a class="btn" href="sidestore://source?url=$SITE/source.json">Add to SideStore</a>
<a class="alt" href="$ASSET_URL">Download the app file (.ipa)</a>
<p>Or add this source in SideStore by hand:<br><code>$SITE/source.json</code></p>
</main></body></html>
HTML

echo "==> build/$IPA ($((SIZE / 1024)) KB)"
if [[ $DEPLOY == 1 ]]; then
  # 1. The .ipa, as an asset of the ios-v<version> release (created once, re-uploaded with --clobber).
  if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
    gh release edit "$TAG" -R "$REPO" --notes "$NOTES" >/dev/null
  else
    gh release create "$TAG" -R "$REPO" --title "Squeak for iPhone $VERSION" --notes "$NOTES" >/dev/null
  fi
  gh release upload "$TAG" "build/$IPA" -R "$REPO" --clobber
  # 2. The source and the pages, as one Pages commit naming only these paths.
  ../macos/scripts/publish-pages.sh --files "Squeak for iPhone $VERSION ($BUILD)" \
    squeak/ios/source.json="$OUT/source.json" squeak/ios/icon.png="$OUT/icon.png" \
    squeak/ios/index.html="$OUT/index.html" squeak/open/index.html=../firebase/pages/open/index.html
  echo "==> $SITE/source.json now offers $VERSION ($BUILD)"
  # 3. Transition: the same source.json (pointing at the GitHub asset) on the old Firebase site.
  if [[ $ALSO_FIREBASE == 1 ]]; then
    if command -v firebase >/dev/null 2>&1; then
      mkdir -p "$PUBLIC"; rm -f "$PUBLIC"/*.ipa "$PUBLIC"/*.zip
      cp "$OUT/source.json" "$OUT/icon.png" "$OUT/index.html" "$PUBLIC/"
      # The hand-written pages (the Telegram "Open in Squeak" hand-off) ship with every deploy.
      cp -R ../firebase/pages/. "$PUBLIC/"
      ../firebase/stage-web.sh
      (cd ../firebase && firebase deploy --only hosting --project "$PROJECT" -m "Squeak $VERSION ($BUILD)")
      echo "==> $OLD_SITE/source.json now points at the GitHub asset"
    else
      echo "==> firebase CLI not found: skipped the transition deploy to $OLD_SITE"
    fi
  fi
  echo "==> Phones: add $SITE/source.json in SideStore (the old $OLD_SITE source keeps working during the transition)."
fi
