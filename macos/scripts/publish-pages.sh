#!/bin/bash
# Publishes build/appcast.xml and build/Squeak-<version>.dmg to sibhimanyu.github.io/squeak/ as ONE commit, without
# cloning that repo (~1.6 GB of old DMGs: the clone took longer than the build). It fetches only the tip commit and its
# trees (no file contents), builds the new tree in the index from that tree plus exactly these paths, checks the commit
# changes nothing else, and pushes it fast-forward only. There is no working tree, so nothing can be "deleted" by a
# missing checkout (a sparse clone's commit once deleted the whole site: the index here starts from the real tree).
# KEEP_DMGS=n removes all but the newest n DMGs from the tree (history keeps them); the default 0 removes nothing.
# Usage: publish-pages.sh <version>     PAGES_BRANCH=main, KEEP_DMGS=3, DRY_PUSH=1 builds and checks the commit but does not push.
set -euo pipefail
VERSION="${1:?usage: publish-pages.sh <version>}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$HERE/build"
URL="https://github.com/Sibhimanyu/Sibhimanyu.github.io.git"
BRANCH="${PAGES_BRANCH:-main}"
KEEP="${KEEP_DMGS:-0}"
DMG="Squeak-$VERSION.dmg"
[ -f "$BUILD/$DMG" ] && [ -f "$BUILD/appcast.xml" ] || { echo "publish-pages: build/$DMG or build/appcast.xml is missing" >&2; exit 1; }
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
DMG_BLOB="$(git hash-object -w "$BUILD/$DMG")"
git update-index --add --cacheinfo "100644,$APPCAST_BLOB,squeak/appcast.xml"
git update-index --add --cacheinfo "100644,$DMG_BLOB,squeak/download/$DMG"

# Optionally keep only the newest KEEP DMGs, the new one included.
git ls-tree -r --name-only "$BASE" -- squeak/download | grep -E '^squeak/download/Squeak-[0-9.]+\.dmg$' > "$WORK/existing.txt" || true
python3 -I - "$VERSION" "$KEEP" "$WORK/existing.txt" > "$WORK/doomed.txt" <<'PY'
import re, sys
version, keep, listing = sys.argv[1], int(sys.argv[2]), sys.argv[3]
existing = [l.strip() for l in open(listing) if l.strip()]
new = f"squeak/download/Squeak-{version}.dmg"
key = lambda p: tuple(int(n) for n in re.findall(r"\d+", p.rsplit("/", 1)[1]))
everything = sorted(set(existing) | {new}, key=key)
for p in everything[:-keep] if keep > 0 else []:
    if p in existing and p != new:
        print(p)
PY
while read -r old; do [ -n "$old" ] && git update-index --force-remove "$old"; done < "$WORK/doomed.txt"

TREE="$(git write-tree --missing-ok)"
COMMIT="$(printf 'Squeak %s\n' "$VERSION" | git commit-tree "$TREE" -p "$BASE")"

# Before anything is live: the commit may change only the named paths.
{ echo "squeak/appcast.xml"; echo "squeak/download/$DMG"; cat "$WORK/doomed.txt"; } | sort > "$WORK/expected.txt"
git diff-tree -r --name-only "$BASE" "$COMMIT" | sort > "$WORK/changed.txt"
if comm -13 "$WORK/expected.txt" "$WORK/changed.txt" | grep -q .; then
  echo "publish-pages: the commit would change files it should not; nothing was pushed:" >&2
  comm -13 "$WORK/expected.txt" "$WORK/changed.txt" >&2
  exit 1
fi

if [ "${DRY_PUSH:-0}" = 1 ]; then echo "publish-pages: built $COMMIT on $BASE; changes: $(tr '\n' ' ' < "$WORK/changed.txt"); not pushed (DRY_PUSH)"; exit 0; fi
echo "publish-pages: pushing $DMG ($(du -h "$BUILD/$DMG" | cut -f1))…"
for attempt in 1 2 3; do
  git push -q --no-thin "$URL" "$COMMIT:refs/heads/$BRANCH" && { echo "publish-pages: $BRANCH is now $COMMIT"; exit 0; }
  echo "publish-pages: push failed (try $attempt)" >&2
done
exit 1
