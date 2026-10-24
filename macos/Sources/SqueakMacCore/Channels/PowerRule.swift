import Foundation

/// The energy mode rule (`src/fleet/power-mode.ts`): it lets the daemon run exactly three `pmset`
/// commands, `-a powermode 0`, `1` and `2` (Automatic, Low Power, High Power), without a password, so
/// the iPhone can pick the Mac's mode. A file of its own, beside the lid rule's and the fans' (an app
/// that does not know it keeps installing those unchanged). The daemon writes the text
/// (`GET /control/power/rule`); this checks it, has visudo check it, and installs it with macOS's
/// own admin prompt, the way `LidRule` does.
public enum PowerRule {
    public static let path = "/etc/sudoers.d/squeak-power"

    static let commands = [
        "/usr/bin/pmset -a powermode 0",
        "/usr/bin/pmset -a powermode 1",
        "/usr/bin/pmset -a powermode 2",
    ]

    /// True only for the rule the daemon builds, for this user: comments, then one line granting the
    /// three commands. Anything else is refused before the admin prompt, since it would run as root.
    public static func isExpected(_ rule: String, user: String) -> Bool {
        guard user.range(of: #"^[a-z_][a-z0-9_.-]{0,31}$"#, options: [.regularExpression, .caseInsensitive]) != nil,
              user.lowercased() != "all" else { return false }
        let grants = rule.split(separator: "\n", omittingEmptySubsequences: true).map(String.init).filter { !$0.hasPrefix("#") }
        return grants == ["\(user) ALL=(root) NOPASSWD: \(commands.joined(separator: ", "))"]
    }

    /// visudo first (a broken file in sudoers.d breaks sudo for everything), then one admin prompt.
    public static func install(_ rule: String, user: String = NSUserName(), run: LidRule.Runner = LidRule.run) async -> LidRule.Outcome {
        guard isExpected(rule, user: user) else { return .failed("Squeak's service sent a rule it doesn't expect, so nothing was installed.") }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("squeak-power-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let file = dir.appendingPathComponent("squeak-power")
            try Data(rule.utf8).write(to: file)
            let check = try await run("/usr/sbin/visudo", ["-c", "-f", file.path])
            guard check.status == 0 else { return .failed("The rule didn't pass visudo: \(check.stderr.trimmingCharacters(in: .whitespacesAndNewlines))") }
            let script = [
                "on run argv",
                #"do shell script "/usr/bin/install -m 0440 -o root -g wheel " & quoted form of (item 1 of argv) & " \#(path)" with prompt "Squeak wants to set your Mac's energy mode (Automatic, Low Power or High Power) when you pick it on your iPhone. This lets it run exactly those three settings without asking again." with administrator privileges"#,
                "end run",
            ]
            let result = try await run("/usr/bin/osascript", script.flatMap { ["-e", $0] } + [file.path])
            if result.status == 0 { return .installed }
            if result.stderr.contains("-128") { return .cancelled }
            return .failed(result.stderr.trimmingCharacters(in: .whitespacesAndNewlines))
        } catch {
            return .failed(error.localizedDescription)
        }
    }
}
