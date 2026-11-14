#!/bin/bash
# One command to release Squeak for Mac:   macos/scripts/release-mac.sh <version> [--dry-run|--finish] [--skip-relay-check]
#
# Builds origin/master in its OWN checkout (default ~/.squeak-release, kept warm between releases), so other chats'
# unfinished edits never ride along and a release never waits for a clean working tree; then publishes:
#   1. macos/scripts/release.sh   tests, app, DMG, Sparkle signature, appcast, release notes
#   2. GitHub release v<version>   notes, checksum and the DMG (`gh release upload --clobber`, once, over the slow uplink).
#                                  The appcast enclosure is https://github.com/Sibhimanyu/squeak/releases/download/
#                                  v<version>/Squeak-<version>.dmg: Pages no longer carries DMGs (three 66 MB ones made a
#                                  ~208 MB deploy that timed out at "syncing_files")
#   3. macos/scripts/publish-pages.sh   the appcast (and delta patches) only, one commit through the API (no 1.6 GB clone)
#   4. waits until the live appcast on Pages and the DMG at the release URL both answer, updates website/release.json,
#      pushes the version commit, then builds the site and republishes squeak/index.html (publish-site.sh; a failure
#      there only warns: the app is live).
# Only one release at a time (a lock). Needs: gh (logged in), Sparkle's private key (release.sh checks), the Apple
# Development identity. The version needs a `## <version>` section in macos/CHANGELOG.md on origin/master.
set -euo pipefail

VERSION="${1:-}"
DRY=0; FINISH=0; SKIP_RELAY=0
for a in "${@:2}"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --finish) FINISH=1 ;;
    --skip-relay-check) SKIP_RELAY=1 ;;
    *) echo "unknown argument $a" >&2; exit 2 ;;
  esac
done
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then echo "usage: $0 <version like 2.12.6> [--dry-run|--finish] [--skip-relay-check]" >&2; exit 2; fi

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$(cd "$HERE/.." && pwd)"
REL="${SQUEAK_RELEASE_DIR:-$HOME/.squeak-release}"
LOCK="/tmp/squeak-mac-release.lock"
START=$SECONDS
# Every step's timing is kept next to the build log, so "why did this one take 9 minutes" has an answer.
mkdir -p "$HOME/.squeak-release-logs"
exec > >(tee -a "$HOME/.squeak-release-logs/release-$VERSION.log") 2>&1
step() { echo; echo "==> $* ($((SECONDS - START)) s)"; }

PAGES="https://sibhimanyu.github.io/squeak"
RELEASE_DL="https://github.com/Sibhimanyu/squeak/releases/download"
# The version of the live appcast's newest item, and its enclosure URL.
appcast_version() { curl -fsS --max-time 15 "$PAGES/appcast.xml?$RANDOM" 2>/dev/null | sed -n 's/.*<sparkle:shortVersionString>\([^<]*\)<.*/\1/p' | head -1 || true; }
appcast_enclosure() { curl -fsS --max-time 15 "$PAGES/appcast.xml?$RANDOM" 2>/dev/null | sed -n 's/.*<enclosure url="\([^"]*\)".*/\1/p' | head -1 || true; }
# Size of a download URL, redirects followed (a release asset redirects to objects.githubusercontent.com): HEAD, and if
# the storage host refuses HEAD, a one-byte range GET and the total from Content-Range. The redirect can take ~75 s
# through a proxy, so this is only a warning check; the pass/fail check is release_asset_ok (GitHub's API).
remote_size() {
  local url="$1" n
  n="$(curl -fsSIL --max-time 120 "$url" 2>/dev/null | tr -d '\r' | sed -n 's/^[Cc]ontent-[Ll]ength: //p' | tail -1 || true)"
  if ! [[ "$n" =~ ^[0-9]+$ ]] || [ "$n" -le 1024 ]; then
    n="$(curl -sSL --max-time 120 -r 0-0 -D - -o /dev/null "$url" 2>/dev/null | tr -d '\r' | sed -n 's#^[Cc]ontent-[Rr]ange: bytes 0-0/\([0-9]*\)$#\1#p' | tail -1 || true)"
  fi
  echo "$n"
}

# The release asset as GitHub's API says it is: its size and sha256 digest must equal the built DMG's. This does not
# depend on the download redirect, which can be slower than any sensible timeout. Prints what it saw on a mismatch.
release_asset_ok() {
  local file="$1" name want_size want_digest got
  name="$(basename "$file")"; want_size="$(stat -f %z "$file")"; want_digest="sha256:$(shasum -a 256 "$file" | cut -d' ' -f1)"
  got="$(gh release view "v$VERSION" --repo Sibhimanyu/squeak --json assets --jq ".assets[] | select(.name == \"$name\") | \"\(.size) \(.digest // \"\")\"" 2>/dev/null || true)"
  [ "$got" = "$want_size $want_digest" ] && return 0
  echo "release asset $name: API says '${got:-nothing}', built file is '$want_size $want_digest'" >&2
  return 1
}

mkdir "$LOCK" 2>/dev/null || { echo "Another Mac release is running (or died: rm -r $LOCK). Not starting a second." >&2; exit 1; }
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

BUILD="$REL/macos/build"
DMG="Squeak-$VERSION.dmg"
if [ "$FINISH" = 1 ]; then
  step "Verify an already published release before finishing its metadata"
  [ -f "$BUILD/$DMG" ] || { echo "No built $DMG to verify." >&2; exit 1; }
  COMMIT="$(gh api "repos/Sibhimanyu/squeak/git/ref/tags/v$VERSION" --jq .object.sha)"
  [ "$(git -C "$REL" rev-parse HEAD)" = "$COMMIT" ] || { echo "Release checkout does not match v$VERSION." >&2; exit 1; }
  # The appcast may have been published a moment ago and Pages not deployed yet: wait up to 15 minutes, like the normal path.
  live_version=""
  for _ in $(seq 1 180); do
    live_version="$(appcast_version)"; [ "$live_version" = "$VERSION" ] && break; sleep 5
  done
  [ "$live_version" = "$VERSION" ] || { echo "Live appcast is '$live_version' after 15 minutes, expected $VERSION." >&2; exit 1; }
  ENCLOSURE="$(appcast_enclosure)"
  case "$ENCLOSURE" in
    "$RELEASE_DL/v$VERSION/$DMG")
      # Made the new way: the DMG is the release's asset. Upload it again only if it is missing or the wrong size
      # (--clobber makes that idempotent), then check what the appcast serves.
      if ! release_asset_ok "$BUILD/$DMG" 2>/dev/null; then
        step "Upload $DMG to the release (missing or wrong size/digest)"
        gh release upload "v$VERSION" "$BUILD/$DMG" --clobber --repo Sibhimanyu/squeak
      fi
      release_asset_ok "$BUILD/$DMG" || { echo "The release asset $ENCLOSURE is not the built $DMG." >&2; exit 1; }
      WANT="$(stat -f %z "$BUILD/$DMG")"
      [ "$(remote_size "$ENCLOSURE")" = "$WANT" ] || echo "WARNING: could not confirm $ENCLOSURE over HTTP (slow redirect?); GitHub's API says the asset is right." >&2 ;;
    "$PAGES/download/$DMG")
      # Made the old way: the DMG is on Pages. The blob ID proves it matches the signed local artifact without
      # downloading another 66 MB over a slow CDN connection.
      published_blob="$(gh api "repos/Sibhimanyu/sibhimanyu.github.io/contents/squeak/download/$DMG?ref=main" --jq .sha)"
      [ "$published_blob" = "$(git hash-object "$BUILD/$DMG")" ] || { echo "Published $DMG differs from the built artifact." >&2; exit 1; } ;;
    *) echo "The live appcast's enclosure is '$ENCLOSURE', not this release's DMG." >&2; exit 1 ;;
  esac
else
step "Checkout of origin/master"
REF="${SQUEAK_RELEASE_REF:-origin/master}"   # another ref only to try the script; a real release is always origin/master
git -C "$SRC" fetch -q origin master
if [ ! -e "$REL/.git" ]; then git -C "$SRC" worktree add -q --detach "$REL" "$REF"; fi
git -C "$REL" checkout -q --detach -f "$REF"
git -C "$REL" clean -fdq   # untracked only: .build and build/ are ignored, so the compile cache stays warm
if [ "$SKIP_RELAY" = 0 ]; then
  step "Cloud relay version check"
  "$REL/scripts/relay-version-check.sh" "$REL/cloud/catalyst-relay/functions/squeak_relay/package.json" || { echo "Nothing was released." >&2; exit 1; }
fi
BUILT_SHA="$(git -C "$REL" rev-parse HEAD)"   # the release tag must name exactly this commit, however far master moves meanwhile
COMMIT="$(git -C "$REL" rev-parse --short HEAD)"
echo "building $COMMIT: $(git -C "$REL" log -1 --format=%s)"

grep -q "^## $VERSION\$" "$REL/macos/CHANGELOG.md" || { echo "macos/CHANGELOG.md on $REF has no '## $VERSION' section. Merge it to master first." >&2; exit 1; }
LIVE="$(appcast_version)"
if [ -n "$LIVE" ]; then
  python3 -I -c 'import sys; v=lambda s: tuple(map(int, s.split("."))); sys.exit(0 if v(sys.argv[1]) > v(sys.argv[2]) else 1)' "$VERSION" "$LIVE" \
    || { echo "$VERSION is not newer than the live $LIVE." >&2; exit 1; }
fi

step "Build, test, DMG, appcast"
mkdir -p "$REL/macos/build"
# The daemon the app embeds is compiled from this checkout (embed-daemon.sh runs its tsc): install when the lockfile changed.
LOCKSUM="$(shasum -a 256 "$REL/package-lock.json" | cut -d' ' -f1)"
if [ ! -x "$REL/node_modules/.bin/tsc" ] || [ "$(cat "$REL/node_modules/.lock-sum" 2>/dev/null)" != "$LOCKSUM" ]; then
  echo "installing the daemon's dependencies (once per lockfile change)"
  (cd "$REL" && npm ci --no-audit --no-fund --loglevel=error) && echo "$LOCKSUM" > "$REL/node_modules/.lock-sum"
fi
(cd "$REL/macos" && ./scripts/release.sh "$VERSION") > "$REL/macos/build/release-$VERSION.log" 2>&1 \
  || { tail -30 "$REL/macos/build/release-$VERSION.log" >&2; echo "release.sh failed; full log: $REL/macos/build/release-$VERSION.log" >&2; exit 1; }
BUILD="$REL/macos/build"
DMG="Squeak-$VERSION.dmg"
echo "built $DMG ($(du -h "$BUILD/$DMG" | cut -f1)), $(grep -c . "$BUILD/release-$VERSION.log") log lines in $BUILD/release-$VERSION.log"
printf '\nDownload: %s/v%s/%s\n' "$RELEASE_DL" "$VERSION" "$DMG" >> "$BUILD/RELEASE_NOTES.md"

if [ "$DRY" = 1 ]; then
  step "Dry run: nothing published"
  echo "would create the GitHub release v$VERSION with $DMG (the appcast enclosure: $RELEASE_DL/v$VERSION/$DMG) and publish the appcast to Pages for $COMMIT. Built files are in $BUILD."
  exit 0
fi

step "GitHub release v$VERSION"
gh release create "v$VERSION" "$BUILD/$DMG.sha256" --repo Sibhimanyu/squeak --target "$BUILT_SHA" \
  --title "Squeak $VERSION" --notes-file "$BUILD/RELEASE_NOTES.md" >/dev/null
# The DMG goes up once, over the slow uplink, and is checked through GitHub's API (size + sha256) BEFORE the appcast points at it.
gh release upload "v$VERSION" "$BUILD/$DMG" --clobber --repo Sibhimanyu/squeak
WANT="$(stat -f %z "$BUILD/$DMG")"
DMG_URL="$RELEASE_DL/v$VERSION/$DMG"
asset_ok=0
for _ in $(seq 1 24); do
  release_asset_ok "$BUILD/$DMG" 2>/dev/null && { asset_ok=1; break; }; sleep 5
done
[ "$asset_ok" = 1 ] || { release_asset_ok "$BUILD/$DMG" || true; echo "Uploaded, but the release asset's size/digest on GitHub differs from the built $DMG (want $WANT bytes). The appcast was NOT published; check the release, then publish the appcast by hand with macos/scripts/publish-pages.sh." >&2; exit 1; }

step "Pages: appcast"
(cd "$REL/macos" && ./scripts/publish-pages.sh "$VERSION")

step "Waiting for the live appcast"
# Pages only serves the appcast now (a few KB), so this is quick; allow 15 minutes for a slow deploy anyway.
seen=""
for _ in $(seq 1 180); do
  seen="$(appcast_version)"
  [ "$seen" = "$VERSION" ] && break
  sleep 5
done
if [ "$seen" != "$VERSION" ]; then
  echo "Timed out after 15 minutes; the appcast on Pages says '$seen', want $VERSION. Check Pages, then rerun with --finish." >&2
  exit 1
fi
# The DMG itself was verified through the API above; the public URL is only a warning (Sparkle users fetch over their own network).
[ "$(remote_size "$DMG_URL")" = "$WANT" ] || echo "WARNING: $DMG_URL did not answer $WANT bytes within the check (slow redirect?); the release asset itself is verified." >&2
# The appcast and patches are published atomically; verify new delta URLs as well
# before considering this update available to clients.
python3 -I "$REL/macos/scripts/appcast-deltas.py" --list "$BUILD/appcast.xml" > "$BUILD/delta-paths.txt"
while read -r patch; do
  [ -n "$patch" ] || continue
  curl -fsSI --max-time 20 --retry 6 --retry-delay 5 "https://sibhimanyu.github.io/$patch" >/dev/null
done < "$BUILD/delta-paths.txt"
fi

step "Website release.json and the version commit"
# Run the metadata helper from this script's checkout so --finish can repair a release
# built before this recovery mode existed. The output belongs to the release checkout.
(cd "$REL/website" && { [ -d node_modules ] || npm ci --silent; } && node "$SRC/website/scripts/release-meta.mjs" --artifact "$BUILD/$DMG" --output "$REL/website/release.json")
git -C "$REL" add macos/scripts/build-app.sh
git -C "$REL" -c user.name="${GIT_AUTHOR_NAME:-Sibhimanyu}" commit -q -m "Mac $VERSION" || true
if ! git -C "$REL" diff --quiet -- website/release.json; then
  git -C "$REL" add website/release.json
  git -C "$REL" commit -q -m "Website release.json: Squeak $VERSION"
fi
pushed=0
for attempt in 1 2 3; do
  # master moves while a release builds: rebase onto it first so the push is a fast-forward
  git -C "$REL" fetch -q origin master && git -C "$REL" rebase -q origin/master || break
  if git -C "$REL" push -q origin HEAD:master 2>/dev/null; then pushed=1; break; fi
done
[ "$pushed" = 1 ] || { echo "could not push the version commit: do it by hand from $REL" >&2; exit 1; }

step "Website page"
if (cd "$REL/website" && { [ -d node_modules ] || npm ci --silent; } && npm run build --silent) >/dev/null 2>&1 \
  && EXPECT_VERSION="$VERSION" "$REL/macos/scripts/publish-site.sh" "$REL/website/dist/index.html"; then
  :
else
  echo "WARNING: the site page was not published (the app is live): run 'cd $REL/website && npm run build && EXPECT_VERSION=$VERSION $REL/macos/scripts/publish-site.sh $REL/website/dist/index.html'" >&2
fi

step "Done"
echo "Squeak $VERSION is live: https://sibhimanyu.github.io/squeak/appcast.xml  (built from $COMMIT in $((SECONDS - START)) s)"
