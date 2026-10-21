#!/usr/bin/env bash
#
# Ship the current worktree to the live checkout and restart Squeak.
#
#   ./scripts/ship.sh
#
# Runs CI, merges this branch into the live branch, builds beside the live
# dist rather than over it, smoke-tests that the build loads, swaps it in,
# then restarts the Squeak service. If Squeak does not answer on its local port
# afterwards, the previous dist is restored and restarted, and the bad build
# is left at dist.failed.
#
# The daemon and its launch agent run from the live checkout. Squeak for Mac
# (macos/) is a native app that ships separately (macos/scripts/release.sh),
# as does the iPhone app (ios/scripts/release.sh).

set -euo pipefail

HEALTH_WAIT="${HEALTH_WAIT:-20}"
PORT="${FLEET_HOOK_PORT:-8477}"
DAEMON="com.squeak.daemon"

say() { printf '%s\n' "$*"; }
die() { printf 'ship: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null || die "git not found"
command -v node >/dev/null || die "node not found"

WORKTREE="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git repository"
REPO_ROOT="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
BRANCH="$(git -C "$WORKTREE" rev-parse --abbrev-ref HEAD)"

[ -n "$REPO_ROOT" ] || die "could not resolve the main checkout"
if [ "$WORKTREE" = "$REPO_ROOT" ]; then
  die "run this from a Conductor workspace, not the live checkout ($REPO_ROOT)"
fi
if [ -n "$(git -C "$WORKTREE" status --porcelain)" ]; then
  die "worktree has uncommitted changes -- commit them first"
fi

LIVE_BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
say "worktree : $WORKTREE ($BRANCH)"
say "live     : $REPO_ROOT ($LIVE_BRANCH)"

# 1. Gate on the full suite, in the worktree, before anything is merged.
say ""
say "running CI in the worktree..."
( cd "$WORKTREE" && npm run ci ) || die "CI failed -- nothing was shipped"

# 2. Merge into the branch Squeak runs from.
say ""
say "merging $BRANCH into $LIVE_BRANCH..."
git -C "$REPO_ROOT" merge --no-edit "$BRANCH" || die "merge failed -- nothing was shipped"

# 3. Build beside the live dist, never over it: a failed compile must not
#    leave Squeak with nothing to restart into.
say "building..."
rm -rf "$REPO_ROOT/dist.new"
( cd "$REPO_ROOT" && npx tsc -p tsconfig.build.json --outDir dist.new ) || die "build failed -- live dist untouched"

# 4. Prove the new build at least loads before it goes live.
say "smoke-testing the new build..."
( cd "$REPO_ROOT" && node -e "
  Promise.all([import('./dist.new/squeak/app.js'), import('./dist.new/squeak/config.js')])
    .then(() => process.exit(0))
    .catch((error) => { console.error(error.message); process.exit(1); });
" ) || { rm -rf "$REPO_ROOT/dist.new"; die "new build does not import -- live dist untouched"; }

# 5. Swap, keeping the outgoing build for rollback.
rm -rf "$REPO_ROOT/dist.prev"
[ -d "$REPO_ROOT/dist" ] && mv "$REPO_ROOT/dist" "$REPO_ROOT/dist.prev"
mv "$REPO_ROOT/dist.new" "$REPO_ROOT/dist"
say "swapped dist (previous kept at dist.prev)"

# 6. Restart and verify. Squeak is not in the path of anything this script's
#    caller is waiting on, so it can restart right away.
restart() {
  local label="$1"
  launchctl kickstart -k "gui/$(id -u)/$label" >/dev/null 2>&1 \
    || say "note: $label is not loaded (run scripts/install-squeak-agents.sh once)"
}

healthy() {
  local i
  for i in $(seq 1 "$HEALTH_WAIT"); do
    curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/state" && return 0
    sleep 1
  done
  return 1
}

say "restarting Squeak..."
restart "$DAEMON"

if healthy; then
  say ""
  say "shipped $BRANCH -> $LIVE_BRANCH; Squeak is up on 127.0.0.1:$PORT"
  exit 0
fi

say "Squeak did not come up -- rolling back"
if [ -d "$REPO_ROOT/dist.prev" ]; then
  rm -rf "$REPO_ROOT/dist.failed"
  mv "$REPO_ROOT/dist" "$REPO_ROOT/dist.failed"
  mv "$REPO_ROOT/dist.prev" "$REPO_ROOT/dist"
  restart "$DAEMON"
  healthy && die "rolled back to the previous build; the bad one is at dist.failed (logs: ~/Library/Logs/squeak)"
fi
die "Squeak is down and no previous build could be restored (logs: ~/Library/Logs/squeak)"
