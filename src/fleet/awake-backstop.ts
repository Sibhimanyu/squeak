import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { logger } from "../utils/logger.js";

/**
 * The last line of defence for an awake session (todo.md, stay-awake plan
 * item 3). The daemon undoes what it changed (sleep disabled, Low Power
 * Mode) when a session ends, when it stops, and when it starts. If it is
 * gone for good — crash loop, uninstalled, launchd agent removed — a Mac
 * left with sleep disabled never sleeps, even in a bag.
 *
 * So a separate launchd agent runs this script every minute. It reads the
 * journal lid-sleep.ts writes before every change and undoes it when the
 * daemon is not running, or when the owning session's end passed more than
 * two minutes ago (the daemon would have undone it by then). With no journal
 * it does nothing. It needs nothing from the daemon, and uses only the four
 * commands the sudoers rule allows.
 */

export const BACKSTOP_LABEL = "com.squeak.awake-backstop";
const DAEMON_LABEL = "com.squeak.daemon";

/**
 * The script, with its paths baked in. `sudo`, `launchctl` and `osascript`
 * are overridable for tests. `actionsPath` is lid-actions.ts's journal (apps
 * paused, sound muted while the lid was shut): undone only when the daemon is
 * not running, since a running one undoes it when the lid opens.
 */
export function backstopScript(journalPath: string, actionsPath: string): string {
  return `#!/bin/bash
# Squeak's awake backstop (src/fleet/awake-backstop.ts). Undoes what Squeak
# journalled but did not undo: a sleep disable or Low Power Mode when the
# daemon is not running or the session's end passed two minutes ago (an
# unreadable journal: sleep, at once); paused apps and muted sound when the
# daemon is not running. No journal: nothing.
JOURNAL=${shellQuote(journalPath)}
ACTIONS=${shellQuote(actionsPath)}
SUDO="\${SQUEAK_BACKSTOP_SUDO:-/usr/bin/sudo}"
LAUNCHCTL="\${SQUEAK_BACKSTOP_LAUNCHCTL:-/bin/launchctl}"
OSASCRIPT="\${SQUEAK_BACKSTOP_OSASCRIPT:-/usr/bin/osascript}"
[ -f "$JOURNAL" ] || [ -f "$ACTIONS" ] || exit 0
running=0
"$LAUNCHCTL" print "gui/$(/usr/bin/id -u)/${DAEMON_LABEL}" 2>/dev/null | /usr/bin/grep -q "state = running" && running=1
if [ "$running" = 0 ] && [ -f "$ACTIONS" ]; then
  act() { /usr/bin/plutil -extract "$1" raw -o - "$ACTIONS" 2>/dev/null; }
  # A paused app is resumed only in the boot it was paused in, and only
  # while its start time still matches: a reused pid is someone else's.
  boot="$(act boot)"
  if [ -z "$boot" ] || [ "$boot" = "$(/usr/sbin/sysctl -n kern.bootsessionuuid 2>/dev/null)" ]; then
    i=0
    while [ "$i" -lt 1000 ]; do
      pid="$(act "frozen.$i.pid")"
      started="$(act "frozen.$i.startedAt")"
      # The first journal held bare pids, with nothing to check them against.
      [ -n "$pid" ] || { pid="$(act "frozen.$i")" && started=""; } || break
      case "$pid" in
        ''|*[!0-9]*) ;;
        *)
          if [ -z "$started" ] || [ "$(TZ=UTC /bin/ps -o lstart= -p "$pid" 2>/dev/null | /usr/bin/xargs)" = "$started" ]; then
            kill -CONT "$pid" 2>/dev/null
          fi
          ;;
      esac
      i=$((i + 1))
    done
  fi
  undone=1
  if [ "$(act muted)" = "true" ]; then
    "$OSASCRIPT" -e "set volume without output muted" || undone=0
  fi
  echo "$(/bin/date -u +%FT%TZ) squeak backstop undid $(/bin/cat "$ACTIONS") (ok=$undone)" >&2
  [ "$undone" = 1 ] && /bin/rm -f "$ACTIONS"
fi
[ -f "$JOURNAL" ] || exit 0
field() { /usr/bin/plutil -extract "$1" raw -o - "$JOURNAL" 2>/dev/null; }
# lid-sleep.ts writes every field it knows; none readable means a journal
# that cannot be read, and that must still end in sleep being restored.
readable=0
for key in sleepDisabled lowPower disabledSleepAt; do
  field "$key" >/dev/null && readable=1
done
until_ms="$(field until)"
now_ms="$(( $(/bin/date +%s) * 1000 ))"
if [ "$running" = 1 ] && [ "$readable" = 1 ]; then
  case "$until_ms" in
    ''|*[!0-9]*) exit 0 ;;
  esac
  [ "$now_ms" -gt "$(( until_ms + 120000 ))" ] || exit 0
fi
ok=1
if [ "$(field lowPower)" = "true" ]; then
  "$SUDO" -n /usr/bin/pmset -b lowpowermode 0 || ok=0
fi
if [ "$readable" = 0 ] || [ "$(field sleepDisabled)" = "true" ] || [ -n "$(field disabledSleepAt)" ]; then
  "$SUDO" -n /usr/bin/pmset -a disablesleep 0 || ok=0
fi
echo "$(/bin/date -u +%FT%TZ) squeak backstop undid $(/bin/cat "$JOURNAL") (ok=$ok)" >&2
[ "$ok" = 1 ] && /bin/rm -f "$JOURNAL"
exit 0
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function backstopPlist(scriptPath: string, logPath: string): string {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${BACKSTOP_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${escape(scriptPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardErrorPath</key>
  <string>${escape(logPath)}</string>
</dict>
</plist>
`;
}

/**
 * Writes the script and the agent, and loads it, when either is missing or
 * differs. Called once the sudoers rule is installed; idempotent.
 */
export async function ensureBackstop(options: {
  supportDir: string;
  journalPath: string;
  actionsPath: string;
  launchAgentsDir?: string;
  launchctl?: (args: string[]) => Promise<boolean>;
}): Promise<void> {
  const scriptPath = path.join(options.supportDir, "awake-backstop.sh");
  const plistPath = path.join(
    options.launchAgentsDir ?? path.join(os.homedir(), "Library", "LaunchAgents"),
    `${BACKSTOP_LABEL}.plist`,
  );
  const logPath = path.join(options.supportDir, "awake-backstop.log");
  const script = backstopScript(options.journalPath, options.actionsPath);
  const plist = backstopPlist(scriptPath, logPath);
  const launchctl =
    options.launchctl ??
    ((args: string[]) =>
      new Promise<boolean>((resolve) =>
        execFile("/bin/launchctl", args, { timeout: 10_000 }, (error) => resolve(!error)),
      ));
  const same = (file: string, text: string) => {
    try {
      return fs.readFileSync(file, "utf8") === text;
    } catch {
      return false;
    }
  };
  const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
  const loaded = await launchctl(["print", `${domain}/${BACKSTOP_LABEL}`]);
  if (same(scriptPath, script) && same(plistPath, plist) && loaded) {
    return;
  }
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  fs.chmodSync(scriptPath, 0o700);
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist);
  if (loaded) {
    await launchctl(["bootout", `${domain}/${BACKSTOP_LABEL}`]);
    // bootout is asynchronous; bootstrapping straight after it fails (CLAUDE.md).
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  if (!(await launchctl(["bootstrap", domain, plistPath]))) {
    logger.warn("could not load the awake backstop agent", { plistPath });
    return;
  }
  logger.info("awake backstop agent installed", { plistPath });
}
