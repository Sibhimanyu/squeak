#!/usr/bin/env bash
# Build a Release .ipa and publish it as a SideStore source on Firebase
# Hosting (https://squeak-5c9gvo.web.app). Phones with the source added get
# updates in SideStore. Same pipeline as snof's ios/scripts/release.sh.
#
#   ./scripts/release.sh "What changed, one line"          # build + deploy
#   ./scripts/release.sh "..." --no-deploy                  # build only
#
# The marketing version is MARKETING_VERSION in project.yml: SideStore
# compares marketing versions, not build numbers, so bump it for a release
# to reach phones. The build number is a UTC timestamp.
set -euo pipefail
cd "$(dirname "$0")/.."

NOTES="${1:?usage: release.sh \"release notes\" [--no-deploy]}"
DEPLOY=1; [[ "${2:-}" == "--no-deploy" ]] && DEPLOY=0

PROJECT="$(python3 -c "import json; print(json.load(open('../firebase/.firebaserc'))['projects']['default'])")"
SITE="https://$PROJECT.web.app"
PUBLIC="../firebase/public"
BUNDLE="$(sed -n 's/^SQUEAK_BUNDLE_ID *= *//p' Config/App.xcconfig)"
VERSION="$(sed -n 's/^ *MARKETING_VERSION: *"\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' project.yml)"
BUILD="$(date -u +%Y%m%d%H%M)"

LIVE="$(curl -fsS "$SITE/source.json" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['apps'][0]['version'])" 2>/dev/null || true)"
if [[ -n "$LIVE" && $DEPLOY == 1 ]]; then
  python3 - "$VERSION" "$LIVE" <<'PY' || { echo "MARKETING_VERSION $VERSION is not newer than the live $LIVE — bump it in project.yml, or SideStore will never offer this build." >&2; exit 1; }
import sys
v = lambda s: tuple(int(x) for x in s.split("."))
sys.exit(0 if v(sys.argv[1]) > v(sys.argv[2]) else 1)
PY
fi

echo "==> Squeak $VERSION ($BUILD)"
(cd SqueakCore && swift test >/dev/null 2>&1) || { echo "SqueakCore tests failed — run swift test in SqueakCore" >&2; exit 1; }
xcodegen -q
rm -rf build/Release-iphoneos build/ipa build/Build/Products/Release-iphoneos
xcodebuild -project Squeak.xcodeproj -scheme Squeak -configuration Release -sdk iphoneos \
  -destination 'generic/platform=iOS' -derivedDataPath build \
  CURRENT_PROJECT_VERSION="$BUILD" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  build -quiet 2>&1 | grep -E "error:" && exit 1 || true

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
# Published as .zip: new Firebase projects on the free Spark plan refuse
# "executable" uploads, .ipa included. An .ipa is a zip archive, and SideStore
# downloads downloadURL to a file of its own naming, so the bytes are what
# matter, not the extension.
IPA="Squeak-$VERSION-$BUILD.zip"
rm -f "$PUBLIC"/*.ipa "$PUBLIC"/*.zip
(cd build/ipa && COPYFILE_DISABLE=1 zip -qry "../../$PUBLIC/$IPA" Payload)
SIZE=$(stat -f%z "$PUBLIC/$IPA")
SHA=$(shasum -a 256 "$PUBLIC/$IPA" | cut -d' ' -f1)
cp Squeak/Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png "$PUBLIC/icon.png"

python3 - "$VERSION" "$BUILD" "$NOTES" "$SITE/$IPA" "$SIZE" "$SHA" "$BUNDLE" "$SITE" "$PUBLIC" <<'PY'
import json, sys, datetime
version, build, notes, url, size, sha, bundle, site, public = sys.argv[1:]
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
v = {"version": version, "buildVersion": build, "date": now, "localizedDescription": notes,
     "downloadURL": url, "size": int(size), "sha256": sha, "minOSVersion": "18.0"}
source = {
  "name": "Squeak", "identifier": "com.squeak.source",
  "subtitle": "Your coding agents, in your pocket", "website": site,
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
json.dump(source, open(f"{public}/source.json", "w"), indent=2)
PY

cat > "$PUBLIC/index.html" <<HTML
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
<img src="icon.png" alt=""><h1>Squeak</h1>
<p>Version $VERSION ($BUILD). $(printf '%s' "$NOTES" | sed 's/&/\&amp;/g; s/</\&lt;/g')</p>
<a class="btn" href="sidestore://source?url=$SITE/source.json">Add to SideStore</a>
<a class="alt" href="$IPA">Download the app file (an .ipa, served as .zip)</a>
<p>Needs SideStore on the phone first. Or add this source in SideStore by hand:<br><code>$SITE/source.json</code></p>
</main></body></html>
HTML

echo "==> $PUBLIC/$IPA ($((SIZE / 1024)) KB)"
if [[ $DEPLOY == 1 ]]; then
  (cd ../firebase && firebase deploy --only hosting --project "$PROJECT" -m "Squeak $VERSION ($BUILD)")
  echo "==> $SITE/source.json now offers $VERSION ($BUILD)"
fi
