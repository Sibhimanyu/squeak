import Foundation

/// A second chance for the reopen after an update. Sparkle's installer is meant to relaunch Squeak when it has
/// swapped the app in, but on a real Mac that sometimes does not happen: the app quits for "Restart to update"
/// and nothing comes back. So just before it quits, the app starts this small detached shell script. It waits for
/// the app to be gone, then for either the new app to be running (Sparkle did its job: nothing to do) or the
/// installed version to have changed and a few seconds to have passed (the install finished and no one reopened
/// it), or a time limit (the install failed: the old app is still on disk). Then it opens Squeak if it is not
/// already running. A quit the person chose ("Quit Squeak") never arms it.
public enum RelaunchWatchdog {
    /// `$1` the app's pid, `$2` the app bundle, `$3` the version running now, `$4` the limit in seconds,
    /// `$5` the grace in seconds after the version changes. `SQUEAK_OPEN` and `SQUEAK_PGREP` are swapped for stubs by tests.
    public static let script = #"""
    OPEN="${SQUEAK_OPEN:-/usr/bin/open}"
    PGREP="${SQUEAK_PGREP:-/usr/bin/pgrep}"
    PID="$1"; APP="$2"; OLD="$3"; LIMIT="$4"; GRACE="$5"
    running() { "$PGREP" -f "$APP/Contents/MacOS/" >/dev/null 2>&1; }
    while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done
    i=0
    while [ "$i" -lt "$LIMIT" ]; do
      if running; then exit 0; fi
      NEW=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null)
      if [ -n "$NEW" ] && [ "$NEW" != "$OLD" ]; then
        sleep "$GRACE"
        running || "$OPEN" "$APP"
        exit 0
      fi
      sleep 1
      i=$((i + 1))
    done
    running || "$OPEN" "$APP"
    """#

    public static func arguments(pid: Int32, appPath: String, version: String, limit: Int = 90, grace: Int = 4) -> [String] {
        ["-c", script, "squeak-relaunch", String(pid), appPath, version, String(limit), String(grace)]
    }

    private static let armed = NSLock()
    nonisolated(unsafe) private static var didArm = false

    /// Starts the detached watcher once per run of the app. Never throws: a failure to start it only loses the safety net.
    @discardableResult
    public static func arm(pid: Int32 = ProcessInfo.processInfo.processIdentifier,
                           appPath: String = Bundle.main.bundlePath,
                           version: String = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "") -> Bool {
        armed.lock()
        let first = !didArm
        didArm = true
        armed.unlock()
        guard first, !version.isEmpty else { return false }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = arguments(pid: pid, appPath: appPath, version: version)
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            return true
        } catch {
            return false
        }
    }
}
