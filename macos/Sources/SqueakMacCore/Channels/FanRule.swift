import Foundation

/// Fan control for a Mac kept awake in a bag (`src/fleet/heat.ts`): the bundled `squeak-fans`
/// helper copied root-owned to `/Library/PrivilegedHelperTools`, and a sudoers rule that lets the
/// daemon run exactly its five fan commands without a password. Installed together, with macOS's own
/// admin prompt, the way `LidRule` is. Five fixed settings (full, 80, 60, 40 per cent, back to the system), never
/// an open-ended speed: the sudoers rule names each one. Root-owned matters: a helper the user could rewrite would be a
/// way to root for anything running as them.
public enum FanRule {
    public static let path = "/etc/sudoers.d/squeak-fans"
    public static let helperPath = "/Library/PrivilegedHelperTools/com.squeak.fans"

    static var commands: [String] { ["max", "80", "60", "40", "auto"].map { "\(helperPath) \($0)" } }

    /// True only for the rule the daemon builds, for this user: comments, then one line granting
    /// the five commands. Anything else is refused before the admin prompt.
    public static func isExpected(_ rule: String, user: String) -> Bool {
        guard user.range(of: #"^[a-z_][a-z0-9_.-]{0,31}$"#, options: [.regularExpression, .caseInsensitive]) != nil,
              user.lowercased() != "all" else { return false }
        let grants = rule.split(separator: "\n", omittingEmptySubsequences: true).map(String.init).filter { !$0.hasPrefix("#") }
        return grants == ["\(user) ALL=(root) NOPASSWD: \(commands.joined(separator: ", "))"]
    }

    /// The helper inside this app's bundle.
    public static var bundledHelper: URL {
        Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/squeak-fans")
    }

    /// The Team ID a `codesign -dv` report names; nil for ad hoc or unsigned code.
    static func teamIdentifier(_ report: String) -> String? {
        for line in report.split(separator: "\n") where line.hasPrefix("TeamIdentifier=") {
            let team = String(line.dropFirst("TeamIdentifier=".count))
            return team == "not set" ? nil : team
        }
        return nil
    }

    /// visudo first (a broken file in sudoers.d breaks sudo for everything), then the helper must carry
    /// this app's own signature, so a swapped file is not what gets installed as root. Then one admin
    /// prompt installs both, root-owned.
    public static func install(
        _ rule: String, user: String = NSUserName(), helper: URL = bundledHelper, app: URL = Bundle.main.bundleURL,
        run: LidRule.Runner = LidRule.run
    ) async -> LidRule.Outcome {
        guard isExpected(rule, user: user) else { return .failed("Squeak's service sent a rule it doesn't expect, so nothing was installed.") }
        guard FileManager.default.isExecutableFile(atPath: helper.path) else {
            return .failed("This copy of Squeak has no fan helper. Update Squeak first.")
        }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("squeak-fans-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        do {
            let verify = try await run("/usr/bin/codesign", ["--verify", "--strict", helper.path])
            guard verify.status == 0 else { return .failed("The fan helper's signature didn't check out, so nothing was installed.") }
            let helperTeam = teamIdentifier(try await run("/usr/bin/codesign", ["-dv", helper.path]).stderr)
            let appTeam = teamIdentifier(try await run("/usr/bin/codesign", ["-dv", app.path]).stderr)
            guard let helperTeam, helperTeam == appTeam else {
                return .failed("The fan helper isn't signed by the same developer as Squeak, so nothing was installed.")
            }
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let file = dir.appendingPathComponent("squeak-fans")
            try Data(rule.utf8).write(to: file)
            let check = try await run("/usr/sbin/visudo", ["-c", "-f", file.path])
            guard check.status == 0 else { return .failed("The rule didn't pass visudo: \(check.stderr.trimmingCharacters(in: .whitespacesAndNewlines))") }
            let commands = [
                "/usr/bin/install -d -o root -g wheel -m 0755 /Library/PrivilegedHelperTools",
                "/usr/bin/install -o root -g wheel -m 0755 \" & quoted form of (item 2 of argv) & \" \(helperPath)",
                "/usr/bin/install -o root -g wheel -m 0440 \" & quoted form of (item 1 of argv) & \" \(path)",
            ].joined(separator: " && ")
            let script = [
                "on run argv",
                #"do shell script "\#(commands)" with prompt "Squeak wants to control your Mac's fans: full speed when it gets hot while kept awake, and the speed you pick on your iPhone. This installs a small helper that can only set the fans." with administrator privileges"#,
                "end run",
            ]
            let result = try await run("/usr/bin/osascript", script.flatMap { ["-e", $0] } + [file.path, helper.path])
            if result.status == 0 { return .installed }
            if result.stderr.contains("-128") { return .cancelled }
            return .failed(result.stderr.trimmingCharacters(in: .whitespacesAndNewlines))
        } catch {
            return .failed(error.localizedDescription)
        }
    }
}
