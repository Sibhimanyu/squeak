#!/usr/bin/env bash
#
# Ship the current worktree's branch to the live bridge.
#
# The bridge runs from the main checkout. Conductor workspaces are git worktrees
# on their own branches, so an agent can edit and test freely without touching
# the process that is serving the conversation. This script is the deliberate
# step that closes that gap.
#
# It must never leave the user without a working bridge: CI has to pass, the new
# build has to import cleanly before it is swapped in, and if the bridge fails to
# come back up the previous dist is restored automatically.
#
# The restart is detached and delayed so the reply explaining what happened is
# delivered before the process handling it is killed.

set -euo pipefail

RESTART_DELAY="${RESTART_DELAY:-8}"
HEALTH_WAIT="${HEALTH_WAIT:-20}"
LABEL="com.conductor-tg.bridge"
LOG="$HOME/Library/Logs/conductor-tg/bridge.log"
CONFIG_DIR="$HOME/Library/Application Support/conductor-tg"

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

# 2. Merge into the branch the bridge runs from.
say ""
say "merging $BRANCH into $LIVE_BRANCH..."
git -C "$REPO_ROOT" merge --no-edit "$BRANCH" || die "merge failed -- nothing was shipped"

# 3. Build beside the live dist, never over it.
say "building..."
rm -rf "$REPO_ROOT/dist.new"
( cd "$REPO_ROOT" && npx tsc -p tsconfig.build.json --outDir dist.new ) || die "build failed -- live dist untouched"

# 4. Prove the new build at least loads before it goes anywhere near the bridge.
say "smoke-testing the new build..."
( cd "$REPO_ROOT" && node -e "
  Promise.all([import('./dist.new/index.js'), import('./dist.new/cli.js')])
    .then(() => process.exit(0))
    .catch((error) => { console.error(error.message); process.exit(1); });
" ) || { rm -rf "$REPO_ROOT/dist.new"; die "new build does not import -- live dist untouched"; }

# 5. Swap, keeping the outgoing build for rollback.
rm -rf "$REPO_ROOT/dist.prev"
[ -d "$REPO_ROOT/dist" ] && mv "$REPO_ROOT/dist" "$REPO_ROOT/dist.prev"
mv "$REPO_ROOT/dist.new" "$REPO_ROOT/dist"
say "swapped dist (previous kept at dist.prev)"

# 6. Restart out of band, after this turn's reply has had time to go out, then
#    verify and roll back if the bridge did not come up.
cat > "$REPO_ROOT/.ship-restart.sh" <<RESTART
#!/usr/bin/env bash
set -uo pipefail
sleep $RESTART_DELAY

restart_bridge() {
  if launchctl list 2>/dev/null | grep -q "$LABEL"; then
    launchctl kickstart -k "gui/\$(id -u)/$LABEL" >/dev/null 2>&1
  else
    pkill -f "conductor-tg/dist/cli.js" >/dev/null 2>&1
    sleep 3
    cd "$CONFIG_DIR" || exit 1
    nohup node "$REPO_ROOT/dist/cli.js" start >> "$LOG" 2>&1 &
  fi
}

healthy() {
  pgrep -f "conductor-tg/dist/cli.js" >/dev/null 2>&1
}

echo "===== ship: restarting \$(date) =====" >> "$LOG"
restart_bridge
sleep $HEALTH_WAIT

if healthy; then
  echo "===== ship: bridge healthy =====" >> "$LOG"
else
  echo "===== ship: bridge did not come up, rolling back =====" >> "$LOG"
  if [ -d "$REPO_ROOT/dist.prev" ]; then
    rm -rf "$REPO_ROOT/dist.failed"
    mv "$REPO_ROOT/dist" "$REPO_ROOT/dist.failed"
    mv "$REPO_ROOT/dist.prev" "$REPO_ROOT/dist"
    restart_bridge
    sleep $HEALTH_WAIT
    if healthy; then
      echo "===== ship: rolled back, bridge healthy (bad build at dist.failed) =====" >> "$LOG"
    else
      echo "===== ship: ROLLBACK FAILED -- bridge is down =====" >> "$LOG"
    fi
  fi
fi
rm -f "$REPO_ROOT/.ship-restart.sh"
RESTART

chmod +x "$REPO_ROOT/.ship-restart.sh"
nohup "$REPO_ROOT/.ship-restart.sh" >/dev/null 2>&1 &
disown 2>/dev/null || true

say ""
say "shipped $BRANCH -> $LIVE_BRANCH"
say "the bridge restarts in ${RESTART_DELAY}s; if it fails to come up, dist.prev is restored automatically"
say "watch: tail -f \"$LOG\""
