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

write_agent() {
  local label="$1" logname="$2"; shift 2
  local args="" arg
  for arg in "$@"; do args+="        <string>${arg}</string>"$'\n'; done

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
    <true/>
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
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$label.plist"
  say "loaded $label"
}

write_agent com.squeak.daemon squeak "$NODE" "$REPO_ROOT/dist/squeak/cli.js" start

ELECTRON="$REPO_ROOT/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ -x "$ELECTRON" ]; then
  write_agent com.squeak.duck duck "$ELECTRON" "$REPO_ROOT/desktop"
else
  say "skipping the duck: no electron at $ELECTRON (run: cd $REPO_ROOT/desktop && npm install)"
fi

say ""
say "logs: $LOGDIR"
say "stop: launchctl bootout gui/\$(id -u)/com.squeak.daemon"
