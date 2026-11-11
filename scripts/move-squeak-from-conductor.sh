#!/usr/bin/env bash
#
# Move the Squeak repo itself out of Conductor's folders into Squeak's own:
# the live checkout (~/conductor/repos/squeak -> ~/squeak/repos/squeak) and its
# Conductor worktrees (-> ~/squeak/workspaces/squeak/<name>), through
# `squeak move-from-conductor --repo squeak`, then re-point the launch agents.
#
#   scripts/move-squeak-from-conductor.sh [--dry-run] [--help]
#
# Run it from Terminal (cd ~ first), not from inside the checkout or a Conductor
# workspace, with Conductor quit. The daemon and the session host are stopped
# for the move and brought back from the new path; if the move is refused or
# fails they are started again from the unchanged plists.
#
# The command runs from a clone of dist/ and node_modules in a temp folder, so
# the CLI does not hold the checkout open while it is being moved.

set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { printf 'move-squeak-from-conductor: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: scripts/move-squeak-from-conductor.sh [--dry-run] [--help]

Moves the Squeak repo (the live checkout) and its Conductor worktrees into
~/squeak: ~/squeak/repos/squeak and ~/squeak/workspaces/squeak/<name>.

  --dry-run   run `squeak move-from-conductor --repo squeak --dry-run` and show
              what the script would also do; changes nothing, stops nothing
  --help      this text

Run it from Terminal outside the checkout and outside ~/conductor/workspaces/squeak
(cd ~ first), with Conductor quit.
USAGE
}

DRY=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY=1 ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { usage >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
OLD="$(git -C "$SCRIPT_DIR" worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
NEW="$HOME/squeak/repos/squeak"
CONDUCTOR_REPOS="$HOME/conductor/repos"
CONDUCTOR_WS="$HOME/conductor/workspaces/squeak"
AGENTS="$HOME/Library/LaunchAgents"
LOGDIR="$HOME/Library/Logs/squeak"
LABELS=(com.squeak.host com.squeak.daemon)
uid="$(id -u)"

# ---- 1. checks, before anything is touched ----------------------------------
[ -n "$OLD" ] && [ -d "$OLD/.git" ] || die "could not find the live checkout (got '$OLD')"
OLD="$(cd "$OLD" && pwd -P)"
case "$OLD" in
  "$HOME/conductor/repos/"*) ;;
  *) die "the live checkout is $OLD, not under $CONDUCTOR_REPOS: nothing to move" ;;
esac
HERE="$(pwd -P)"
case "$HERE/" in
  "$OLD"/*) die "run this from outside the checkout (cd ~ first)" ;;
  "$CONDUCTOR_WS"/*) die "run this from outside $CONDUCTOR_WS (cd ~ first): that folder is moved" ;;
esac
[ -z "$(git -C "$OLD" status --porcelain --untracked-files=no)" ] || die "the live checkout has uncommitted changes"
[ -f "$OLD/dist/squeak/cli.js" ] || die "no built squeak at $OLD/dist"
[ -d "$OLD/node_modules" ] || die "no node_modules in $OLD"
# ps, not pgrep: pgrep sees no processes from some sandboxed shells and would wave this through.
if ps -axo comm= | grep -q '/Conductor\.app/Contents/MacOS/'; then
  die "Conductor is running: quit it first (its warm agent processes hold the worktrees)"
fi
[ ! -e "$NEW" ] || die "$NEW already exists"

# The node the daemon runs with.
NODE=""
if [ -f "$AGENTS/com.squeak.daemon.plist" ]; then
  NODE="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$AGENTS/com.squeak.daemon.plist" 2>/dev/null || true)"
fi
[ -n "$NODE" ] && [ -x "$NODE" ] || NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "node not found"

# ---- 2. a runnable CLI that is not inside the checkout ----------------------
# Real path: macOS temp dirs sit behind /var -> /private/var, and the CLI only runs when argv[1] resolves to its own file.
TMP="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/squeak-move.XXXXXX")" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT
say "copying the CLI out of the checkout (APFS clone)..."
for item in dist node_modules package.json; do
  cp -c -R "$OLD/$item" "$TMP/$item" || die "could not copy $item"
done
CLI=("$NODE" "$TMP/dist/squeak/cli.js")

# ---- 3. dry run -------------------------------------------------------------
if [ "$DRY" -eq 1 ]; then
  say ""
  "${CLI[@]}" move-from-conductor --repo squeak --dry-run
  say ""
  say "The real run would also:"
  say "  - stop com.squeak.host and com.squeak.daemon for the move (started again if it fails)"
  say "  - git worktree repair for any worktree the command does not move"
  say "  - run $NEW/scripts/install-squeak-agents.sh to point both agents at $NEW"
  say "  - wait for 127.0.0.1:8477 (daemon) and 127.0.0.1:8479 (host)"
  say "Dry run: nothing was changed or stopped."
  exit 0
fi

# ---- 4. every worktree, before the move -------------------------------------
WORKTREES=()
while IFS= read -r line; do
  case "$line" in
    "worktree "*) [ "${line#worktree }" != "$OLD" ] && WORKTREES+=("${line#worktree }") ;;
  esac
done < <(git -C "$OLD" worktree list --porcelain)

say "moving $OLD"
say "    to $NEW"
say "(${#WORKTREES[@]} linked worktree(s))"

# ---- 5. stop the agents -----------------------------------------------------
wait_gone() {
  local label="$1" i
  for i in $(seq 1 40); do
    launchctl print "gui/$uid/$label" >/dev/null 2>&1 || return 0
    sleep 0.25
  done
  return 1
}
for label in "${LABELS[@]}"; do
  launchctl bootout "gui/$uid/$label" 2>/dev/null || true
done
for label in "${LABELS[@]}"; do
  wait_gone "$label" || die "$label did not stop; nothing was moved (rerun, or bootstrap it again by hand)"
done

# Back to the unchanged plists, then wait for the daemon: used when the move fails.
restore_agents() {
  local label i
  say "starting the agents again from the unchanged plists..."
  for label in "${LABELS[@]}"; do
    for i in 1 2 3; do
      launchctl bootstrap "gui/$uid" "$AGENTS/$label.plist" 2>/dev/null && break
      sleep 1
    done
  done
  for i in $(seq 1 40); do
    curl -fsS --max-time 2 http://127.0.0.1:8477/state >/dev/null 2>&1 && { say "the daemon answers again"; return 0; }
    sleep 0.5
  done
  say "WARNING: the daemon is not answering on 127.0.0.1:8477; see $LOGDIR/squeak.log"
}

# ---- 6. the move ------------------------------------------------------------
set +e
"${CLI[@]}" move-from-conductor --repo squeak
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  restore_agents
  die "the move failed or was refused (exit $rc); see above. Nothing was moved unless it says so."
fi
[ -d "$NEW/.git" ] || { restore_agents; die "$NEW has no checkout after the command"; }

# ---- 7. worktrees the command did not move ----------------------------------
for wt in ${WORKTREES[@]+"${WORKTREES[@]}"}; do
  if [ -d "$wt" ]; then
    say "repairing link for $wt"
    git -C "$NEW" worktree repair "$wt" || say "WARNING: repair failed for $wt"
  fi
done

# ---- 8. point the launch agents at the new path -----------------------------
say ""
say "re-pointing the launch agents..."
( cd "$NEW" && ./scripts/install-squeak-agents.sh ) || say "WARNING: install-squeak-agents.sh reported a problem (see above)"

# ---- 9. health --------------------------------------------------------------
say ""
bad=0
up=0
for _ in $(seq 1 40); do
  curl -fsS --max-time 2 http://127.0.0.1:8477/state >/dev/null 2>&1 && { up=1; break; }
  sleep 0.5
done
if [ "$up" -eq 1 ]; then say "daemon answers on 127.0.0.1:8477"; else bad=1; say "!!! the daemon does NOT answer on 127.0.0.1:8477 (waited 20 s)"; fi
up=0
for _ in $(seq 1 20); do
  # Any HTTP answer counts (the host may refuse without its token).
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:8479/ 2>/dev/null || true)" != "000" ] && { up=1; break; }
  sleep 0.5
done
if [ "$up" -eq 1 ]; then say "host answers on 127.0.0.1:8479"; else bad=1; say "!!! the session host does NOT answer on 127.0.0.1:8479 (waited 10 s)"; fi
if [ "$bad" -eq 1 ]; then
  say "    logs: $LOGDIR/squeak.log (daemon), $LOGDIR/squeak-host.log (host)"
  say "    retry: launchctl bootstrap gui/$uid $AGENTS/<label>.plist"
fi

# ---- 10. closing note -------------------------------------------------------
say ""
say "done."
say "  - Conductor still lists squeak with missing folders: don't open it there."
say "    Continue squeak's chats in Squeak."
say "  - the live checkout is now $NEW"
say "  - run scripts/ship.sh from a worktree in ~/squeak/workspaces/squeak/<name>"
[ "$bad" -eq 0 ] || exit 1
