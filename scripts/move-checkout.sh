#!/usr/bin/env bash
#
# Move the main checkout to a new folder and re-point everything that runs
# from it: the launch agents, Squeak.app's loader, and git's links to every
# worktree.
#
#   scripts/move-checkout.sh [new-path]      # default: ~/conductor/repos/squeak
#
# Run it from Terminal, not from inside a Conductor workspace. Conductor keeps
# its own record of the path and name: quit Conductor and run
# scripts/rename-in-conductor.py afterwards, which updates it in place and
# keeps every workspace and chat.

set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { printf 'move-checkout: %s\n' "$*" >&2; exit 1; }

OLD="$(git -C "$(dirname "$0")" worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
NEW="${1:-$HOME/conductor/repos/squeak}"
NEW="${NEW%/}"

[ -d "$OLD/.git" ] || die "could not find the main checkout (got '$OLD')"
[ "$OLD" != "$NEW" ] || die "already at $NEW"
[ ! -e "$NEW" ] || die "$NEW already exists"
case "$PWD/" in
  "$OLD"/*) die "run this from outside the checkout (cd ~ first)" ;;
esac
[ -z "$(git -C "$OLD" status --porcelain --untracked-files=no)" ] || die "the checkout has uncommitted changes"

say "moving $OLD"
say "    to $NEW"

uid="$(id -u)"
for label in com.squeak.duck com.squeak.daemon; do
  launchctl bootout "gui/$uid/$label" 2>/dev/null || true
done
# bootout is asynchronous; wait for both to be gone before moving their code.
for _ in $(seq 1 40); do
  launchctl print "gui/$uid/com.squeak.daemon" >/dev/null 2>&1 || launchctl print "gui/$uid/com.squeak.duck" >/dev/null 2>&1 || break
  sleep 0.25
done

# Listed before the move: afterwards each worktree's link names the old path,
# and repair can only fix the ones it is told about.
WORKTREES=()
while IFS= read -r line; do
  case "$line" in "worktree "*) [ "${line#worktree }" != "$OLD" ] && WORKTREES+=("${line#worktree }") ;; esac
done < <(git -C "$OLD" worktree list --porcelain)

mkdir -p "$(dirname "$NEW")"
mv "$OLD" "$NEW"

# Every linked worktree records the main checkout's path; repair rewrites them.
git -C "$NEW" worktree repair ${WORKTREES[@]+"${WORKTREES[@]}"}

# The app first: its loader names the checkout's path, and the launch agent
# starts it the moment it is loaded.
if [ -d "$HOME/Applications/Squeak.app" ]; then
  say ""
  say "rebuilding Squeak.app's loader..."
  ( cd "$NEW" && ./scripts/build-squeak-app.sh )
fi

say ""
say "re-pointing the launch agents..."
( cd "$NEW" && ./scripts/install-squeak-agents.sh )

say ""
say "done. One step left: quit Conductor, then run"
say "  $NEW/scripts/rename-in-conductor.py"
say "so Conductor's own records carry the new path and name."
