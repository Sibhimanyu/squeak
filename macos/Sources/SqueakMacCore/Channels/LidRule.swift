import Foundation

/// The sudoers rule lid-closed awake sessions need (`src/fleet/lid-sleep.ts`): it lets
/// the daemon run exactly four `pmset` commands without a password. The daemon writes
/// the text (`GET /control/keep-awake/lid-rule`); this checks it, has visudo check it,
/// and installs it with macOS's own admin prompt. Port of the retired `desktop/squeak-service.js`.
public enum LidRule {
    public static let path = "/etc/sudoers.d/squeak"

    static let commands = [
        "/usr/bin/pmset -a disablesleep 1",
        "/usr/bin/pmset -a disablesleep 0",
        "/usr/bin/pmset -b lowpowermode 1",
        "/usr/bin/pmset -b lowpowermode 0",
    ]

    /// True only for the rule the daemon builds, for this user: comments, then one line
    /// granting the four commands. Anything else is refused before the admin prompt,
    /// since whatever is installed there runs as root.
    public static func isExpected(_ rule: String, user: String) -> Bool {
        guard user.range(of: #"^[a-z_][a-z0-9_.-]{0,31}$"#, options: [.regularExpression, .caseInsensitive]) != nil,
              user.lowercased() != "all" else { return false }
        let lines = rule.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        let grants = lines.filter { !$0.hasPrefix("#") }
        return grants == ["\(user) ALL=(root) NOPASSWD: \(commands.joined(separator: ", "))"]
    }

    public enum Outcome: Equatable, Sendable {
        case installed
        case cancelled
        case failed(String)
    }

    /// Output of a finished process.
    public struct Ran: Sendable { public var status: Int32; public var stderr: String }
    public typealias Runner = @Sendable (_ executable: String, _ arguments: [String]) async throws -> Ran

    /// visudo first: a broken file in sudoers.d breaks sudo for everything. Then the admin
    /// prompt copies it into place, root-owned and read-only.
    public static func install(_ rule: String, user: String = NSUserName(), run: Runner = Self.run) async -> Outcome {
        guard isExpected(rule, user: user) else { return .failed("Squeak's service sent a rule it doesn't expect, so nothing was installed.") }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("squeak-sudoers-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let file = dir.appendingPathComponent("squeak")
            try Data(rule.utf8).write(to: file)
            let check = try await run("/usr/sbin/visudo", ["-c", "-f", file.path])
            guard check.status == 0 else { return .failed("The rule didn't pass visudo: \(check.stderr.trimmingCharacters(in: .whitespacesAndNewlines))") }
            let script = [
                "on run argv",
                #"do shell script "/usr/bin/install -m 0440 -o root -g wheel " & quoted form of (item 1 of argv) & " \#(path)" with prompt "Squeak wants to keep your Mac awake with the lid closed. This lets it turn sleep and Low Power Mode on and off without asking again." with administrator privileges"#,
                "end run",
            ]
            let result = try await run("/usr/bin/osascript", script.flatMap { ["-e", $0] } + [file.path])
            if result.status == 0 { return .installed }
            // osascript: "User cancelled. (-128)" when the prompt is dismissed.
            if result.stderr.contains("-128") { return .cancelled }
            return .failed(result.stderr.trimmingCharacters(in: .whitespacesAndNewlines))
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    public static let run: Runner = { executable, arguments in
        try await withCheckedThrowingContinuation { cont in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: executable)
            p.arguments = arguments
            let err = Pipe()
            p.standardOutput = FileHandle.nullDevice
            p.standardError = err
            p.terminationHandler = { proc in
                let text = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                cont.resume(returning: Ran(status: proc.terminationStatus, stderr: text))
            }
            do { try p.run() } catch { cont.resume(throwing: error) }
        }
    }
}
