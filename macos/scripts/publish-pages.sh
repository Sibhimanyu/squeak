#!/bin/bash
# Publishes build/appcast.xml (and the delta patches it references) to sibhimanyu.github.io/squeak/ as ONE commit,
# without cloning that repo (~1.6 GB of old DMGs: the clone took longer than the build). It fetches only the tip commit
# and its trees (no file contents), builds the new tree in the index from that tree plus exactly these paths, checks the
# commit changes nothing else, and pushes it fast-forward only. There is no working tree, so nothing can be "deleted" by
# a missing checkout (a sparse clone's commit once deleted the whole site: the index here starts from the real tree).
# It never adds a DMG: the DMG is the GitHub release's asset (release-mac.sh uploads it), because three 66 MB DMGs made a
# ~208 MB Pages deploy that timed out at "syncing_files".
# --prune-dmgs (off by default, a one-time cleanup, never run by release-mac.sh) also removes the old
# squeak/download/Squeak-*.dmg from the tree, except any the new appcast still names as an enclosure (history keeps them).
# Usage: publish-pages.sh <version> [--prune-dmgs]     PAGES_BRANCH=main, DRY_PUSH=1 builds and checks the commit but does not push.
set -euo pipefail
VERSION="${1:?usage: publish-pages.sh <version> [--prune-dmgs]}"
PRUNE=0
if [ "${2:-}" = "--prune-dmgs" ]; then PRUNE=1; elif [ -n "${2:-}" ]; then echo "publish-pages: unknown option $2" >&2; exit 2; fi
HERE="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$(cd "${SQUEAK_MAC_BUILD_DIR:-$HERE/build}" && pwd)"
URL="https://github.com/Sibhimanyu/Sibhimanyu.github.io.git"
BRANCH="${PAGES_BRANCH:-main}"
[ -f "$BUILD/appcast.xml" ] || { echo "publish-pages: build/appcast.xml is missing" >&2; exit 1; }
grep -q "<sparkle:shortVersionString>$VERSION<" "$BUILD/appcast.xml" || { echo "publish-pages: appcast.xml does not carry $VERSION" >&2; exit 1; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
git init -q .
# Never a delta against, or a fetch of, an old DMG: the new file goes up whole.
git config core.bigFileThreshold 1m
git config pack.window 0
git config http.postBuffer 524288000

echo "publish-pages: reading the tip of $BRANCH (commit and trees only)…"
git fetch -q --depth=1 --filter=blob:none "$URL" "$BRANCH"
BASE="$(git rev-parse FETCH_HEAD)"
# From here nothing may fetch a file: a missing object is an error, never a download of an old DMG.
export GIT_NO_LAZY_FETCH=1
git read-tree "$BASE"

APPCAST_BLOB="$(git hash-object -w "$BUILD/appcast.xml")"
git update-index --add --cacheinfo "100644,$APPCAST_BLOB,squeak/appcast.xml"

# Publish every signed incremental archive referenced by the feed in the same
# commit as the appcast. Retained older items may reference already hosted files.
python3 -I "$HERE/scripts/appcast-deltas.py" --list "$BUILD/appcast.xml" > "$WORK/wanted-deltas.txt"
while read -r path; do
  [ -n "$path" ] || continue
  patch="$BUILD/${path##*/}"
  if [ -f "$patch" ]; then
    blob="$(git hash-object -w "$patch")"
    git update-index --add --cacheinfo "100644,$blob,$path"
  elif [ "$(git ls-tree --name-only "$BASE" -- "$path")" != "$path" ]; then
    echo "publish-pages: feed references missing $path; nothing published" >&2; exit 1
  fi
done < "$WORK/wanted-deltas.txt"

# One-time cleanup (--prune-dmgs): old DMGs no longer served from Pages, unless the appcast still names one.
: > "$WORK/doomed.txt"
if [ "$PRUNE" = 1 ]; then
  git ls-tree -r --name-only "$BASE" -- squeak/download | grep -E '^squeak/download/Squeak-[0-9.]+\.dmg$' > "$WORK/existing.txt" || true
  grep -oE 'url="https://sibhimanyu\.github\.io/squeak/download/Squeak-[0-9.]+\.dmg"' "$BUILD/appcast.xml" | sed -E 's#url="https://sibhimanyu\.github\.io/(.*)"#\1#' | sort -u > "$WORK/referenced.txt" || true
  sort -u "$WORK/existing.txt" | comm -23 - "$WORK/referenced.txt" >> "$WORK/doomed.txt"
fi
# Remove patches only when no retained feed item references them.
git ls-tree -r --name-only "$BASE" -- squeak/download | grep -E '^squeak/download/Squeak[A-Za-z0-9._-]+\.delta$' | sort > "$WORK/existing-deltas.txt" || true
comm -23 "$WORK/existing-deltas.txt" "$WORK/wanted-deltas.txt" >> "$WORK/doomed.txt"
while read -r old; do [ -n "$old" ] && git update-index --force-remove "$old"; done < "$WORK/doomed.txt"

TREE="$(git write-tree --missing-ok)"
COMMIT="$(printf 'Squeak %s\n' "$VERSION" | git commit-tree "$TREE" -p "$BASE")"

# Before anything is live: the commit may change only the named paths.
{ echo "squeak/appcast.xml"; cat "$WORK/wanted-deltas.txt" "$WORK/doomed.txt"; } | sort > "$WORK/expected.txt"
git diff-tree -r --name-only "$BASE" "$COMMIT" | sort > "$WORK/changed.txt"
if comm -13 "$WORK/expected.txt" "$WORK/changed.txt" | grep -q .; then
  echo "publish-pages: the commit would change files it should not; nothing was pushed:" >&2
  comm -13 "$WORK/expected.txt" "$WORK/changed.txt" >&2
  exit 1
fi

if [ "${DRY_PUSH:-0}" = 1 ]; then echo "publish-pages: built $COMMIT on $BASE; changes: $(tr '\n' ' ' < "$WORK/changed.txt"); not pushed (DRY_PUSH)"; exit 0; fi
echo "publish-pages: pushing the appcast ($(wc -c < "$BUILD/appcast.xml" | tr -d ' ') bytes)…"
for attempt in 1 2 3; do
  git push -q --no-thin "$URL" "$COMMIT:refs/heads/$BRANCH" && { echo "publish-pages: $BRANCH is now $COMMIT"; exit 0; }
  echo "publish-pages: push failed (try $attempt)" >&2
done
exit 1
