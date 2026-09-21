#!/usr/bin/env bash
#
# Install launchd agents for Squeak and the desktop duck, so both start at
# login and come back if they die.
#
# Deliberately points at the MAIN CHECKOUT, never a Conductor worktree: those
# are archived when a workspace is done, and a login item that depends on one
# breaks silently weeks later.

set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { printf 'install-squeak-agents: %s\n' "$*" >&2; exit 1; }

REPO_ROOT="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
NODE="$(command -v node)" || die "node not found"
AGENTS="$HOME/Library/LaunchAgents"
LOGDIR="$HOME/Library/Logs/squeak"

[ -f "$REPO_ROOT/dist/squeak/cli.js" ] || die "no built squeak at $REPO_ROOT/dist -- ship first"
mkdir -p "$AGENTS" "$LOGDIR"

# keep_alive: "always" for the daemon, "unless-quit" for anything the user can
# quit from a menu. KeepAlive=true restarts on *any* exit, so a deliberate Quit
# comes straight back and looks like the app ignoring you.
# keep_alive: "always" for the daemon, "unless-quit" for anything the user can
# quit from a menu. KeepAlive=true restarts on *any* exit, so a deliberate Quit
# comes straight back and reads as the app ignoring you.
write_plist() {
  local label="$1" logname="$2" keep_alive="$3"; shift 3
  local args="" arg keepalive_xml
  for arg in "$@"; do args+="        <string>${arg}</string>"$'\n'; done

  if [ "$keep_alive" = "always" ]; then
    keepalive_xml="    <true/>"
  else
    keepalive_xml="    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>"
  fi

  cat > "$AGENTS/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$label</string>
    <key>ProgramArguments</key>
    <array>
$args    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
$keepalive_xml
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>$LOGDIR/$logname.log</string>
    <key>StandardErrorPath</key>
    <string>$LOGDIR/$logname.log</string>
</dict>
</plist>
PLIST

  plutil -lint "$AGENTS/$label.plist" >/dev/null || die "$label.plist is malformed"
}

# bootout is asynchronous: bootstrapping too soon fails with "Input/output
# error" and leaves nothing loaded. Wait for the old job to actually go, then
# retry, and never abort the script -- a half-installed set of agents with one
# service booted out is worse than the problem this script solves.
load_plist() {
  local label="$1" domain="gui/$(id -u)" i

  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    launchctl bootout "$domain/$label" 2>/dev/null || true
    for i in $(seq 1 40); do
      launchctl print "$domain/$label" >/dev/null 2>&1 || break
      sleep 0.25
    done
  fi

  for i in 1 2 3; do
    if launchctl bootstrap "$domain" "$AGENTS/$label.plist" 2>/dev/null; then
      say "loaded $label"
      return 0
    fi
    sleep 1
  done

  say "WARNING: could not load $label"
  say "  retry with: launchctl bootstrap $domain $AGENTS/$label.plist"
  return 1
}

write_plist com.squeak.daemon squeak always "$NODE" "$REPO_ROOT/dist/squeak/cli.js" start

ELECTRON="$REPO_ROOT/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ -x "$ELECTRON" ]; then
  write_plist com.squeak.duck duck unless-quit "$ELECTRON" "$REPO_ROOT/desktop"
else
  say "skipping the duck: no electron at $ELECTRON (run: cd $REPO_ROOT/desktop && npm install)"
fi

# Every plist is on disk before anything is unloaded.
failed=0
load_plist com.squeak.daemon || failed=1
[ -x "$ELECTRON" ] && { load_plist com.squeak.duck || failed=1; }

say ""
say "logs: $LOGDIR"
say "stop:  launchctl bootout gui/\$(id -u)/com.squeak.daemon"
say "duck:  quit it from the menu bar; it returns at next login, or now with"
say "       launchctl kickstart gui/\$(id -u)/com.squeak.duck"

[ "$failed" -eq 0 ] || die "one or more agents did not load (see above)"
