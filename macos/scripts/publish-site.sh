#!/bin/bash
# Publishes the built marketing page (website/dist/index.html) to sibhimanyu.github.io/squeak/index.html as ONE commit,
# the way publish-pages.sh publishes the appcast: no clone of that repo (~1.6 GB), only the tip commit and its trees are
# fetched, the new tree is built in the index from the real tree plus exactly this one path, the commit is checked to
# change nothing else, and it is pushed fast-forward only. If the page is byte-identical to the live one, nothing is pushed.
# Refuses a build without the PageSense snippet (id="pagesenseCode") or, when EXPECT_VERSION is set, without that version.
# Usage: publish-site.sh <path-to-built-index.html>     PAGES_BRANCH=main, EXPECT_VERSION=2.12.27, DRY_PUSH=1 builds and checks but does not push.
set -euo pipefail
FILE="${1:?usage: publish-site.sh <path-to-built-index.html>}"
FILE="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"   # absolute: the script works in a temp dir
URL="https://github.com/Sibhimanyu/Sibhimanyu.github.io.git"
BRANCH="${PAGES_BRANCH:-main}"
DEST="squeak/index.html"
[ -s "$FILE" ] || { echo "publish-site: $FILE is missing or empty" >&2; exit 1; }
grep -q 'id="pagesenseCode"' "$FILE" || { echo "publish-site: $FILE has no id=\"pagesenseCode\"; wrong build, nothing published" >&2; exit 1; }
if [ -n "${EXPECT_VERSION:-}" ]; then
  grep -qF "$EXPECT_VERSION" "$FILE" || { echo "publish-site: $FILE does not mention $EXPECT_VERSION; wrong build, nothing published" >&2; exit 1; }
fi

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
git init -q .
git config core.bigFileThreshold 1m
git config pack.window 0
git config http.postBuffer 524288000

echo "publish-site: reading the tip of $BRANCH (commit and trees only)…"
git fetch -q --depth=1 --filter=blob:none "$URL" "$BRANCH"
BASE="$(git rev-parse FETCH_HEAD)"
# From here nothing may fetch a file: a missing object is an error, never a download of an old DMG.
export GIT_NO_LAZY_FETCH=1
git read-tree "$BASE"

BLOB="$(git hash-object -w "$FILE")"
LIVE="$(git rev-parse -q --verify "$BASE:$DEST" 2>/dev/null || true)"
if [ "$BLOB" = "$LIVE" ]; then echo "publish-site: $DEST unchanged; nothing to publish"; exit 0; fi
git update-index --add --cacheinfo "100644,$BLOB,$DEST"

TREE="$(git write-tree --missing-ok)"
COMMIT="$(printf 'Squeak site%s\n' "${EXPECT_VERSION:+ $EXPECT_VERSION}" | git commit-tree "$TREE" -p "$BASE")"

# Before anything is live: the commit may change only the one page.
git diff-tree -r --name-only "$BASE" "$COMMIT" > "$WORK/changed.txt"
if [ -s "$WORK/changed.txt" ] && [ "$(cat "$WORK/changed.txt")" != "$DEST" ]; then
  echo "publish-site: the commit would change files it should not; nothing was pushed:" >&2
  cat "$WORK/changed.txt" >&2
  exit 1
fi

if [ "${DRY_PUSH:-0}" = 1 ]; then echo "publish-site: built $COMMIT on $BASE; changes: $(tr '\n' ' ' < "$WORK/changed.txt"); not pushed (DRY_PUSH)"; exit 0; fi
echo "publish-site: pushing $DEST…"
for attempt in 1 2 3; do
  git push -q --no-thin "$URL" "$COMMIT:refs/heads/$BRANCH" && { echo "publish-site: $BRANCH is now $COMMIT"; exit 0; }
  echo "publish-site: push failed (try $attempt)" >&2
done
exit 1
