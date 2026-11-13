#!/usr/bin/env bash
#
# Ship the current worktree to the live checkout and restart Squeak.
#
#   ./scripts/ship.sh [--restart-host] [--skip-relay-check]
#
# The native session host (com.squeak.host) is a separate process so that
# restarting the daemon never kills a running chat turn. It is restarted only
# when src/native/ changed in what is shipped and no native chat is running;
# --restart-host forces it.
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
HOST="com.squeak.host"
HOST_PORT="${SQUEAK_HOST_PORT:-8479}"
FORCE_HOST=0
SKIP_RELAY=0

for arg in "$@"; do
  case "$arg" in
    --restart-host) FORCE_HOST=1 ;;
    --skip-relay-check) SKIP_RELAY=1 ;;
    *) printf 'ship: unknown argument %s\n' "$arg" >&2; exit 2 ;;
  esac
done

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

# 0. The hosted cloud relay must be at least the version this build needs (deploy-hosted.sh updates it).
if [ "$SKIP_RELAY" = 0 ]; then
  "$WORKTREE/scripts/relay-version-check.sh" "$WORKTREE/cloud/catalyst-relay/functions/squeak_relay/package.json" || die "relay too old -- nothing was shipped"
fi

# 1. Gate on the full suite, in the worktree, before anything is merged.
say ""
say "running CI in the worktree..."
( cd "$WORKTREE" && npm run ci ) || die "CI failed -- nothing was shipped"

# 2. Merge into the branch Squeak runs from.
say ""
say "merging $BRANCH into $LIVE_BRANCH..."
OLD_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD)"
git -C "$REPO_ROOT" merge --no-edit "$BRANCH" || die "merge failed -- nothing was shipped"

# 2b. Dependencies. A ship that failed after its merge leaves package.json/package-lock.json changed in the live
#     checkout with nothing installed, so compare against the stamp the last good install wrote, not OLD_HEAD
#     (no stamp yet: OLD_HEAD). Install with the node the daemon runs on: better-sqlite3 is built for one ABI.
DEPS_STAMP="$REPO_ROOT/.ship-deps-stamp"
HOST_STAMP="$REPO_ROOT/.ship-host-commit"
lock_hash() { shasum -a 256 < "$REPO_ROOT/package-lock.json" 2>/dev/null | cut -d' ' -f1; }
deps_hash() { cat "$REPO_ROOT/package.json" "$REPO_ROOT/package-lock.json" 2>/dev/null | shasum -a 256 | cut -d' ' -f1; }

daemon_node() {
  local plist="$HOME/Library/LaunchAgents/$DAEMON.plist" bin
  bin="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$plist" 2>/dev/null)" || return 1
  [ -x "$bin" ] && case "$(basename "$bin")" in node*) printf '%s' "$bin"; return 0 ;; esac
  return 1
}

deps_changed=0
if [ -f "$DEPS_STAMP" ]; then
  [ "$(sed -n 1p "$DEPS_STAMP")" = "$(deps_hash)" ] || deps_changed=1
elif ! git -C "$REPO_ROOT" diff --quiet "$OLD_HEAD" HEAD -- package.json package-lock.json 2>/dev/null; then
  deps_changed=1
fi

# better-sqlite3 must load under the daemon's node, whatever else changed.
verify_sqlite() { ( cd "$REPO_ROOT" && node -e "new (require('better-sqlite3'))(':memory:').close()" ) >/dev/null 2>&1; }

if DAEMON_NODE="$(daemon_node)"; then
  export PATH="$(dirname "$DAEMON_NODE"):$PATH"
  [ "$(command -v node)" = "$DAEMON_NODE" ] || [ "$(node -v)" = "$("$DAEMON_NODE" -v)" ] \
    || die "node on PATH ($(node -v)) is not the daemon's ($("$DAEMON_NODE" -v)) -- nothing built"
else
  say "note: could not read the daemon's node from its launch agent; using $(node -v) from PATH"
fi

if [ "$deps_changed" = 1 ]; then
  say ""
  say "dependencies changed; installing in the live checkout with node $(node -v)..."
  if [ "$(sed -n 2p "$DEPS_STAMP" 2>/dev/null)" != "$(lock_hash)" ]; then
    ( cd "$REPO_ROOT" && npm ci ) || die "npm ci failed -- live dist untouched"
  else
    ( cd "$REPO_ROOT" && npm install ) || die "npm install failed -- live dist untouched"
  fi
fi
if ! verify_sqlite; then
  say "better-sqlite3 does not load under node $(node -v); rebuilding..."
  ( cd "$REPO_ROOT" && npm rebuild better-sqlite3 ) >/dev/null 2>&1 || true
  verify_sqlite || die "better-sqlite3 will not load under node $(node -v) -- live dist untouched"
fi
printf '%s\n%s\n' "$(deps_hash)" "$(lock_hash)" > "$DEPS_STAMP"

# 3. Build beside the live dist, never over it: a failed compile must not
#    leave Squeak with nothing to restart into.
say "building..."
rm -rf "$REPO_ROOT/dist.new"
( cd "$REPO_ROOT" && npx tsc -p tsconfig.build.json --outDir dist.new ) || die "build failed -- live dist untouched"
# Add-ons present in the checkout (addons/<name>/) are built into the new dist too; without this a ship would
# drop them and the daemon would treat them as removed.
( cd "$REPO_ROOT" && ADDONS_DIST=dist.new scripts/addons.sh build ) || { rm -rf "$REPO_ROOT/dist.new"; die "add-on build failed -- live dist untouched"; }

# 4. Prove the new build at least loads before it goes live.
say "smoke-testing the new build..."
( cd "$REPO_ROOT" && node -e "
  const fs = require('node:fs');
  const addon = './dist.new/addons/conductor/index.js';
  Promise.all([import('./dist.new/squeak/app.js'), import('./dist.new/squeak/config.js'), ...(fs.existsSync(addon) ? [import(addon)] : [])])
    .then(() => process.exit(0))
    .catch((error) => { console.error(error.message); process.exit(1); });
" ) || { rm -rf "$REPO_ROOT/dist.new"; die "new build does not import -- live dist untouched"; }

# 4b. A restart cuts a phone call off, so wait for one to end (15 minutes at most). The running daemon says
#     whether a call is up; one that cannot be reached, or is too old to have the route, counts as not busy.
call_busy() {
  local token_file="$HOME/Library/Application Support/squeak/hook-token" token body
  [ -r "$token_file" ] || return 1
  token="$(tr -d '[:space:]' < "$token_file")"
  body="$(curl -fsS --max-time 3 -H "x-squeak-token: $token" "http://127.0.0.1:$PORT/control/voice/busy" 2>/dev/null)" || return 1
  case "$body" in *'"busy":true'*) return 0 ;; esac
  return 1
}

if call_busy; then
  say ""
  say "a call is in progress, waiting for it to end..."
  waited=0
  while call_busy; do
    if [ "$waited" -ge "${CALL_WAIT:-900}" ]; then
      say "warning: the call is still up after $((waited / 60)) minutes; restarting anyway"
      break
    fi
    sleep 5
    waited=$((waited + 5))
  done
fi

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

# Stops a job gracefully (SIGTERM, up to 8 s) so KeepAlive restarts it; kickstart -k only if it will not exit.
restart_gracefully() {
  local label="$1" target pid i
  target="gui/$(id -u)/$label"
  pid="$(launchctl print "$target" 2>/dev/null | awk '/^[[:space:]]*pid = / {print $3; exit}')"
  if [ -z "$pid" ]; then
    restart "$label"
    return
  fi
  launchctl kill SIGTERM "$target" >/dev/null 2>&1 || true
  for i in $(seq 1 16); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  say "note: $label ignored SIGTERM for 8 s; forcing a restart"
  restart "$label"
}

# Healthy = answering /state with the ready state: the early listener's "starting" placeholder does not count.
healthy() {
  local i body
  for i in $(seq 1 "$HEALTH_WAIT"); do
    body="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/state" 2>/dev/null)" \
      && ! printf '%s' "$body" | grep -q '"starting":true' && return 0
    sleep 1
  done
  return 1
}

say "restarting Squeak..."
restart_gracefully "$DAEMON"

# 7. The session host. Only after the daemon is proven healthy (a rollback must not
#    leave the host on new code), and never over a running chat. Nothing here rolls back.
host_token() { tr -d '[:space:]' < "$HOME/Library/Application Support/squeak/hook-token" 2>/dev/null; }

# Prints the host's sessions JSON; fails when it cannot be reached or refuses.
host_sessions() {
  local token; token="$(host_token)" || return 1
  [ -n "$token" ] || return 1
  curl -fsS --max-time 3 -H "x-squeak-token: $token" "http://127.0.0.1:$HOST_PORT/native/sessions" 2>/dev/null
}

# Prints how many chats are working or waiting on the person; host down = 0.
host_busy_count() {
  local body
  body="$(host_sessions)" || { echo 0; return 0; }
  printf '%s' "$body" | node -e "
    let t=''; process.stdin.on('data', d => t += d).on('end', () => {
      try {
        const list = JSON.parse(t).sessions || [];
        const busy = list.filter(s => s.busy === true || ['working','cancelling','stopping'].includes(s.status) || /^(needs_|awaiting_)/.test(String(s.status)));
        console.log(busy.length);
      } catch { console.log(0); }
    });" 2>/dev/null || echo 0
}

host_healthy() {
  local i
  for i in $(seq 1 10); do
    host_sessions >/dev/null && return 0
    sleep 1
  done
  return 1
}

restart_host_if_needed() {
  local native_changed=0 busy since="$OLD_HEAD" head_now
  head_now="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  # Compare against the commit the host was last started from, not OLD_HEAD: a ship that failed after its
  # merge (build or smoke) leaves OLD_HEAD == HEAD next time while the running host is still older.
  if [ -r "$HOST_STAMP" ]; then
    stamped="$(tr -d '[:space:]' < "$HOST_STAMP")"
    git -C "$REPO_ROOT" cat-file -e "$stamped^{commit}" 2>/dev/null && since="$stamped"
  fi
  if ! git -C "$REPO_ROOT" diff --quiet "$since" HEAD -- src/native/ 2>/dev/null; then native_changed=1; fi
  if [ "$FORCE_HOST" -ne 1 ] && [ "$native_changed" -ne 1 ]; then
    printf '%s\n' "$head_now" > "$HOST_STAMP"
    return 0
  fi
  busy="$(host_busy_count)"
  if [ "$FORCE_HOST" -ne 1 ] && [ "${busy:-0}" -gt 0 ]; then
    say "host not restarted: $busy chats running; rerun with --restart-host when they finish"
    return 0
  fi
  say "restarting the session host..."
  restart "$HOST"
  if host_healthy; then
    say "session host is up on 127.0.0.1:$HOST_PORT"
    printf '%s\n' "$head_now" > "$HOST_STAMP"
  else
    say "WARNING: the session host did not answer on 127.0.0.1:$HOST_PORT within 10 s (daemon left as shipped; logs: ~/Library/Logs/squeak)"
  fi
}

if healthy; then
  restart_host_if_needed
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
