#!/bin/bash
# One command to release Squeak for Mac:   macos/scripts/release-mac.sh <version> [--dry-run|--finish]
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
DRY=0; [ "${2:-}" = "--dry-run" ] && DRY=1
FINISH=0; [ "${2:-}" = "--finish" ] && FINISH=1
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then echo "usage: $0 <version like 2.12.6> [--dry-run|--finish]" >&2; exit 2; fi

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
# the storage host refuses HEAD, a one-byte range GET and the total from Content-Range.
remote_size() {
  local url="$1" n
  n="$(curl -fsSIL --max-time 20 "$url" 2>/dev/null | tr -d '\r' | sed -n 's/^[Cc]ontent-[Ll]ength: //p' | tail -1 || true)"
  if ! [[ "$n" =~ ^[0-9]+$ ]] || [ "$n" -le 1024 ]; then
    n="$(curl -sSL --max-time 20 -r 0-0 -D - -o /dev/null "$url" 2>/dev/null | tr -d '\r' | sed -n 's#^[Cc]ontent-[Rr]ange: bytes 0-0/\([0-9]*\)$#\1#p' | tail -1 || true)"
  fi
  echo "$n"
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
  live_version="$(appcast_version)"
  [ "$live_version" = "$VERSION" ] || { echo "Live appcast is $live_version, expected $VERSION." >&2; exit 1; }
  ENCLOSURE="$(appcast_enclosure)"
  case "$ENCLOSURE" in
    "$RELEASE_DL/v$VERSION/$DMG")
      # Made the new way: the DMG is the release's asset. Upload it again only if it is missing or the wrong size
      # (--clobber makes that idempotent), then check what the appcast serves.
      WANT="$(stat -f %z "$BUILD/$DMG")"
      if [ "$(remote_size "$ENCLOSURE")" != "$WANT" ]; then
        step "Upload $DMG to the release (missing or wrong size)"
        gh release upload "v$VERSION" "$BUILD/$DMG" --clobber --repo Sibhimanyu/squeak
      fi
      [ "$(remote_size "$ENCLOSURE")" = "$WANT" ] || { echo "The release asset $ENCLOSURE is not $WANT bytes." >&2; exit 1; }
      asset_digest="$(gh release view "v$VERSION" --repo Sibhimanyu/squeak --json assets --jq ".assets[] | select(.name == \"$DMG\") | .digest // empty" 2>/dev/null || true)"
      if [ -n "$asset_digest" ] && [ "$asset_digest" != "sha256:$(shasum -a 256 "$BUILD/$DMG" | cut -d' ' -f1)" ]; then
        echo "The release asset's digest ($asset_digest) differs from the built $DMG." >&2; exit 1
      fi ;;
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
gh release create "v$VERSION" "$BUILD/$DMG.sha256" --repo Sibhimanyu/squeak --target master \
  --title "Squeak $VERSION" --notes-file "$BUILD/RELEASE_NOTES.md" >/dev/null
# The DMG goes up once, over the slow uplink, and is checked at its public URL BEFORE the appcast points at it.
gh release upload "v$VERSION" "$BUILD/$DMG" --clobber --repo Sibhimanyu/squeak
WANT="$(stat -f %z "$BUILD/$DMG")"
DMG_URL="$RELEASE_DL/v$VERSION/$DMG"
dsize=""
for _ in $(seq 1 24); do
  dsize="$(remote_size "$DMG_URL")"; [ "$dsize" = "$WANT" ] && break; sleep 5
done
[ "$dsize" = "$WANT" ] || { echo "Uploaded, but $DMG_URL answers '$dsize' bytes (want $WANT). The appcast was NOT published; check the release, then publish the appcast by hand with macos/scripts/publish-pages.sh." >&2; exit 1; }

step "Pages: appcast"
(cd "$REL/macos" && ./scripts/publish-pages.sh "$VERSION")

step "Waiting for the live appcast and the DMG"
# Pages only serves the appcast now (a few KB), so this is quick; allow 15 minutes for a slow deploy anyway.
seen=""; size=""
for _ in $(seq 1 180); do
  seen="$(appcast_version)"
  size="$(remote_size "$DMG_URL")"
  [ "$seen" = "$VERSION" ] && [ "$size" = "$WANT" ] && break
  sleep 5
done
if [ "$seen" != "$VERSION" ] || [ "$size" != "$WANT" ]; then
  missing=""
  [ "$seen" = "$VERSION" ] || missing="the appcast on Pages (says '$seen', want $VERSION)"
  [ "$size" = "$WANT" ] || missing="${missing:+$missing and }the DMG at $DMG_URL (says '$size' bytes, want $WANT)"
  echo "Timed out after 15 minutes; missing: $missing. Check Pages / the release, then rerun with --finish." >&2
  exit 1
fi
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
for attempt in 1 2 3; do
  git -C "$REL" push -q origin HEAD:master && break
  git -C "$REL" fetch -q origin master && git -C "$REL" rebase -q origin/master || { echo "could not push the version commit: do it by hand from $REL" >&2; exit 1; }
done

step "Website page"
if (cd "$REL/website" && { [ -d node_modules ] || npm ci --silent; } && npm run build --silent) >/dev/null 2>&1 \
  && EXPECT_VERSION="$VERSION" "$REL/macos/scripts/publish-site.sh" "$REL/website/dist/index.html"; then
  :
else
  echo "WARNING: the site page was not published (the app is live): run 'cd $REL/website && npm run build && EXPECT_VERSION=$VERSION $REL/macos/scripts/publish-site.sh $REL/website/dist/index.html'" >&2
fi

step "Done"
echo "Squeak $VERSION is live: https://sibhimanyu.github.io/squeak/appcast.xml  (built from $COMMIT in $((SECONDS - START)) s)"
