import Foundation

/// A second chance for the reopen after an update. Sparkle's installer is meant to relaunch Squeak when it has
/// swapped the app in, but on a real Mac that sometimes does not happen: the app quits for "Restart to update"
/// and nothing comes back. So just before it quits, the app starts this small detached shell script. It waits for
/// the app to be gone, then for either the new app to be running (Sparkle did its job: nothing to do) or the
/// installed version to have changed and a few seconds to have passed (the install finished and no one reopened
/// it), or a time limit (the install failed: the old app is still on disk). Then it opens Squeak if it is not
/// already running (and once more a few seconds later if it still is not). A quit the person chose ("Quit
/// Squeak") never arms it.
///
/// A failed install does not need the 90 s limit: Sparkle's installer (`Autoupdate`, launchd job
/// `<bundle id>-sparkle-updater`) exits when it gives up (on a real Mac macOS refused the in-place swap with EPERM
/// 18 ms after the app quit, and nothing reopened Squeak). So once the old app is gone, the installer job and process
/// have been absent for ~3 s in a row and the installed version is unchanged, the install has failed: the app is
/// reopened at once, and the installer's last error lines are copied from the unified log (best effort, redacted,
/// after the reopen) to `updates.log` and to `installer-reason.txt` beside it, for the app's message on return.
///
/// Every attempt has its own token file. The script runs only while that file exists, so an attempt that was
/// abandoned (the install failed or timed out and the app kept running) is disarmed by deleting it, and can never
/// reopen the app after a later quit the person chose. Arming again replaces the previous attempt.
public enum RelaunchWatchdog {
    /// `$1` the app's pid, `$2` the app bundle, `$3` the version running now, `$4` the limit in seconds,
    /// `$5` the grace in seconds after the version changes, `$6` the token file (the script stops when it is gone),
    /// `$7` a log file to append to (may be empty), `$8` how long to wait for the app to quit at all, `$9` the
    /// Sparkle installer's launchd job label (empty: skip the launchctl check).
    /// `SQUEAK_OPEN`, `SQUEAK_PGREP`, `SQUEAK_LAUNCHCTL`, `SQUEAK_LOGSHOW`, `SQUEAK_RETRY_DELAY` and
    /// `SQUEAK_INSTALLER_ABSENT` (seconds of stable absence, default 3) are swapped for stubs by tests.
    public static let script = #"""
    OPEN="${SQUEAK_OPEN:-/usr/bin/open}"
    PGREP="${SQUEAK_PGREP:-/usr/bin/pgrep}"
    LAUNCHCTL="${SQUEAK_LAUNCHCTL:-/bin/launchctl}"
    LOGSHOW="${SQUEAK_LOGSHOW:-/usr/bin/log}"
    RETRY="${SQUEAK_RETRY_DELAY:-4}"
    ABSENT="${SQUEAK_INSTALLER_ABSENT:-3}"
    PID="$1"; APP="$2"; OLD="$3"; LIMIT="$4"; GRACE="$5"; TOKEN="$6"; LOG="$7"; WAIT="${8:-300}"; JOB="$9"
    log() { [ -n "$LOG" ] && printf '%s watchdog: %s\n' "$(/bin/date '+%Y-%m-%dT%H:%M:%S%z')" "$1" >> "$LOG" 2>/dev/null; return 0; }
    armed() { [ -e "$TOKEN" ]; }
    running() { "$PGREP" -f "$APP/Contents/MacOS/" >/dev/null 2>&1; }
    installer_running() {
      [ -n "$JOB" ] && "$LAUNCHCTL" print "gui/$(/usr/bin/id -u)/$JOB" >/dev/null 2>&1 && return 0
      "${SQUEAK_INSTALLER_PGREP:-$PGREP}" -f 'Sparkle.framework/Versions/B/[A]utoupdate' >/dev/null 2>&1
    }
    # The installer's last error lines, redacted down to the app bundle's name. Best effort: never fails the script.
    capture_reason() {
      [ -n "$LOG" ] || return 0
      tmp="$TOKEN.installer"
      ( "$LOGSHOW" show --last 2m --predicate 'process == "Autoupdate"' --style compact > "$tmp" 2>/dev/null ) &
      lp=$!; t=0
      while kill -0 "$lp" 2>/dev/null; do
        [ "$t" -ge 20 ] && { kill "$lp" 2>/dev/null; break; }
        sleep 1; t=$((t + 1))
      done
      lines=$(/usr/bin/grep -i 'error' "$tmp" 2>/dev/null | /usr/bin/tail -n 4 \
        | /usr/bin/sed -E -e 's/^[^]]*\] //' -e 's#/[^ "]*/([A-Za-z0-9._ -]+\.app)#\1#g' -e 's/NSIRD_[A-Za-z0-9_]+/<temp>/g' -e 's#/[^ "]+#<path>#g' \
        | /usr/bin/cut -c1-300)
      rm -f "$tmp"
      if [ -z "$lines" ]; then log "no installer error lines found"; return 0; fi
      printf '%s\n' "$lines" > "$(/usr/bin/dirname "$LOG")/installer-reason.txt" 2>/dev/null
      printf '%s\n' "$lines" | while IFS= read -r l; do
        printf '%s installer: %s\n' "$(/bin/date '+%Y-%m-%dT%H:%M:%S%z')" "$l" >> "$LOG" 2>/dev/null
      done
      return 0
    }
    reopen() {
      armed || { log "disarmed before reopening"; return 0; }
      running && { log "app is already running"; return 0; }
      log "opening Squeak"
      "$OPEN" "$APP" >/dev/null 2>&1
      sleep "$RETRY"
      if armed && ! running; then log "still not running, opening again"; "$OPEN" "$APP" >/dev/null 2>&1; fi
      return 0
    }
    log "armed for pid $PID on $OLD"
    w=0
    while kill -0 "$PID" 2>/dev/null; do
      armed || { log "disarmed while the app was still running"; exit 0; }
      if [ "$w" -ge "$WAIT" ]; then log "the app never quit; giving up"; rm -f "$TOKEN"; exit 0; fi
      sleep 1; w=$((w + 1))
    done
    log "app quit"
    i=0; gone=0
    while [ "$i" -lt "$LIMIT" ]; do
      armed || { log "disarmed"; exit 0; }
      if running; then log "app is running again; nothing to do"; rm -f "$TOKEN"; exit 0; fi
      NEW=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null)
      if [ -n "$NEW" ] && [ "$NEW" != "$OLD" ]; then
        log "installed version is $NEW (was $OLD)"
        sleep "$GRACE"
        reopen; rm -f "$TOKEN"; exit 0
      fi
      if installer_running; then gone=0; else gone=$((gone + 1)); fi
      if [ "$gone" -ge "$ABSENT" ]; then
        log "installer finished without installing; reopening"
        reopen; capture_reason; rm -f "$TOKEN"; exit 0
      fi
      sleep 1
      i=$((i + 1))
    done
    log "no relaunch within ${LIMIT}s"
    reopen
    rm -f "$TOKEN"
    """#

    public static func arguments(pid: Int32, appPath: String, version: String, limit: Int = 90, grace: Int = 4,
                                 token: String, log: String = "", waitForQuit: Int = 300,
                                 installerJob: String = "com.squeak.mac-sparkle-updater") -> [String] {
        ["-c", script, "squeak-relaunch", String(pid), appPath, version, String(limit), String(grace), token, log, String(waitForQuit), installerJob]
    }

    private static let state = NSLock()
    nonisolated(unsafe) private static var currentToken: URL?

    /// Whether an attempt is armed right now.
    public static var isArmed: Bool {
        state.withLock { currentToken.map { FileManager.default.fileExists(atPath: $0.path) } ?? false }
    }

    /// Starts a detached watcher for this attempt, replacing any earlier one. Never throws: a failure to start it
    /// only loses the safety net (and is logged).
    @discardableResult
    public static func arm(pid: Int32 = ProcessInfo.processInfo.processIdentifier,
                           appPath: String = Bundle.main.bundlePath,
                           version: String = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
                           log: UpdateLog = .standard) -> Bool {
        guard !version.isEmpty else { log.write("watchdog: not armed, no app version"); return false }
        disarm(log: nil)
        let token = FileManager.default.temporaryDirectory.appendingPathComponent("squeak-relaunch-\(UUID().uuidString)")
        guard FileManager.default.createFile(atPath: token.path, contents: Data()) else {
            log.write("watchdog: not armed, could not create its token")
            return false
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = arguments(pid: pid, appPath: appPath, version: version, token: token.path, log: log.isEnabled ? log.url.path : "",
                                           installerJob: (Bundle.main.bundleIdentifier ?? "com.squeak.mac") + "-sparkle-updater")
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            state.withLock { currentToken = token }
            log.write("watchdog: armed for version \(version)")
            return true
        } catch {
            try? FileManager.default.removeItem(at: token)
            log.write("watchdog: could not start (\(error.localizedDescription))")
            return false
        }
    }

    /// Cancels the armed attempt: its script sees the token gone and exits without opening anything.
    public static func disarm(log: UpdateLog? = .standard) {
        let token = state.withLock { () -> URL? in defer { currentToken = nil }; return currentToken }
        guard let token else { return }
        try? FileManager.default.removeItem(at: token)
        log?.write("watchdog: disarmed")
    }
}
