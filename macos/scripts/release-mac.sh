#!/bin/bash
# One command to release Squeak for Mac:   macos/scripts/release-mac.sh <version> [--dry-run]
#
# Builds origin/master in its OWN checkout (default ~/.squeak-release, kept warm between releases), so other chats'
# unfinished edits never ride along and a release never waits for a clean working tree; then publishes:
#   1. macos/scripts/release.sh   tests, app, DMG, Sparkle signature, appcast, release notes
#   2. GitHub release v<version>   notes and checksum only (the DMG is served from Pages: GitHub's asset host stalls
#                                  for some networks, and uploading 50 MB twice was the slowest step on this uplink)
#   3. macos/scripts/publish-pages.sh   appcast + DMG as one commit through the API (no 1.6 GB clone)
#   4. waits until the live appcast and the DMG answer, updates website/release.json, pushes the version commit.
# Only one release at a time (a lock). Needs: gh (logged in), Sparkle's private key (release.sh checks), the Apple
# Development identity. The version needs a `## <version>` section in macos/CHANGELOG.md on origin/master.
set -euo pipefail

VERSION="${1:-}"
DRY=0; [ "${2:-}" = "--dry-run" ] && DRY=1
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then echo "usage: $0 <version like 2.12.6> [--dry-run]" >&2; exit 2; fi

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$(cd "$HERE/.." && pwd)"
REL="${SQUEAK_RELEASE_DIR:-$HOME/.squeak-release}"
LOCK="/tmp/squeak-mac-release.lock"
START=$SECONDS
step() { echo; echo "==> $* ($((SECONDS - START)) s)"; }

mkdir "$LOCK" 2>/dev/null || { echo "Another Mac release is running (or died: rm -r $LOCK). Not starting a second." >&2; exit 1; }
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

step "Checkout of origin/master"
REF="${SQUEAK_RELEASE_REF:-origin/master}"   # another ref only to try the script; a real release is always origin/master
git -C "$SRC" fetch -q origin master
if [ ! -e "$REL/.git" ]; then git -C "$SRC" worktree add -q --detach "$REL" "$REF"; fi
git -C "$REL" checkout -q --detach -f "$REF"
git -C "$REL" clean -fdq   # untracked only: .build and build/ are ignored, so the compile cache stays warm
COMMIT="$(git -C "$REL" rev-parse --short HEAD)"
echo "building $COMMIT: $(git -C "$REL" log -1 --format=%s)"

grep -q "^## $VERSION\$" "$REL/macos/CHANGELOG.md" || { echo "macos/CHANGELOG.md on $REF has no '## $VERSION' section. Merge it to master first." >&2; exit 1; }
LIVE="$(curl -fsS --max-time 20 https://sibhimanyu.github.io/squeak/appcast.xml 2>/dev/null | sed -n 's/.*<sparkle:shortVersionString>\([^<]*\)<.*/\1/p' | head -1 || true)"
if [ -n "$LIVE" ]; then
  python3 -I -c 'import sys; v=lambda s: tuple(map(int, s.split("."))); sys.exit(0 if v(sys.argv[1]) > v(sys.argv[2]) else 1)' "$VERSION" "$LIVE" \
    || { echo "$VERSION is not newer than the live $LIVE." >&2; exit 1; }
fi

step "Build, test, DMG, appcast"
mkdir -p "$REL/macos/build"
(cd "$REL/macos" && ./scripts/release.sh "$VERSION") > "$REL/macos/build/release-$VERSION.log" 2>&1 \
  || { tail -30 "$REL/macos/build/release-$VERSION.log" >&2; echo "release.sh failed; full log: $REL/macos/build/release-$VERSION.log" >&2; exit 1; }
BUILD="$REL/macos/build"
DMG="Squeak-$VERSION.dmg"
echo "built $DMG ($(du -h "$BUILD/$DMG" | cut -f1)), $(grep -c . "$BUILD/release-$VERSION.log") log lines in $BUILD/release-$VERSION.log"
printf '\nDownload: https://sibhimanyu.github.io/squeak/download/%s\n' "$DMG" >> "$BUILD/RELEASE_NOTES.md"

if [ "$DRY" = 1 ]; then
  step "Dry run: nothing published"
  echo "would publish $DMG, the appcast and the GitHub release for $COMMIT. Built files are in $BUILD."
  exit 0
fi

step "GitHub release v$VERSION"
gh release create "v$VERSION" "$BUILD/$DMG.sha256" --repo Sibhimanyu/squeak --target master \
  --title "Squeak $VERSION" --notes-file "$BUILD/RELEASE_NOTES.md" >/dev/null

step "Pages: appcast and DMG"
(cd "$REL/macos" && ./scripts/publish-pages.sh "$VERSION")

step "Waiting for the live appcast and DMG"
WANT="$(stat -f %z "$BUILD/$DMG")"
for _ in $(seq 1 60); do
  seen="$(curl -fsS --max-time 15 "https://sibhimanyu.github.io/squeak/appcast.xml?$RANDOM" 2>/dev/null | sed -n 's/.*<sparkle:shortVersionString>\([^<]*\)<.*/\1/p' | head -1 || true)"
  size="$(curl -fsSI --max-time 15 "https://sibhimanyu.github.io/squeak/download/$DMG" 2>/dev/null | tr -d '\r' | sed -n 's/^[Cc]ontent-[Ll]ength: //p' | tail -1 || true)"
  [ "$seen" = "$VERSION" ] && [ "$size" = "$WANT" ] && break
  sleep 5
done
[ "$seen" = "$VERSION" ] && [ "$size" = "$WANT" ] || { echo "Published, but the live appcast says '$seen' and the DMG is '$size' bytes (want $WANT) after 5 minutes. Check Pages." >&2; exit 1; }

step "Website release.json and the version commit"
(cd "$REL/website" && { [ -d node_modules ] || npm ci --silent; } && npm run release --silent) >/dev/null 2>&1 || echo "(website release.json not updated: run 'npm run release' in website/)"
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

step "Done"
echo "Squeak $VERSION is live: https://sibhimanyu.github.io/squeak/appcast.xml  (built from $COMMIT in $((SECONDS - START)) s)"
