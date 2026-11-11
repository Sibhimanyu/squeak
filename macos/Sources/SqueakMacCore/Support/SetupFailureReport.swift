import Foundation

/// What a failed setup step tells the log and a Heresay report: facts only, every line redacted
/// (tokens, keys, e-mails, URLs; the home folder shortened to `~`). Pure, so it is tested without a Mac.
public struct SetupFailureReport: Sendable {
    public var macOS: String
    public var arch: String
    public var appVersion: String
    public var step: String
    public var reason: String
    public var details: String
    public var launchctl: String
    public var logTail: [String]
    public var home: String

    public init(macOS: String, arch: String, appVersion: String, step: String, reason: String, details: String,
                launchctl: String, logTail: [String], home: String) {
        self.macOS = macOS; self.arch = arch; self.appVersion = appVersion; self.step = step; self.reason = reason
        self.details = details; self.launchctl = launchctl; self.logTail = logTail; self.home = home
    }

    /// Lines of the service log kept (newest).
    public static let logLines = 30
    /// A report's text stays under this many bytes; the log tail is cut first.
    public static let maxBytes = 3500

    public func clean(_ line: String) -> String {
        var s = line
        if !home.isEmpty, home != "/" { s = s.replacingOccurrences(of: home, with: "~") }
        return DiagnosticsRedactor.redact(s, keepingPaths: true)
    }

    private var detailLines: [String] {
        details.split(separator: "\n", omittingEmptySubsequences: true).map { clean(String($0)) }
    }
    private var logged: [String] { logTail.suffix(Self.logLines).map(clean) }

    /// One fact per line, for the app's logger.
    public var logFacts: [String] {
        var out = [
            "setup failed: step=\(step)",
            "macOS: \(clean(macOS)), arch: \(arch), app: \(clean(appVersion))",
            "reason: \(clean(reason))",
            "launchctl: \(clean(launchctl))",
        ]
        out += detailLines.map { "failure.json: \($0)" }
        out += logged.map { "squeak.log: \($0)" }
        return out
    }

    /// The short plain summary the report sheet starts with.
    public var summary: String {
        "Setup didn't finish at \"\(step)\" on macOS \(clean(macOS)) (\(arch)), Squeak \(clean(appVersion)). \(clean(reason))"
    }

    /// The summary, then the details, then as much of the service log as fits in `maxBytes`.
    public func reportText(maxBytes: Int = SetupFailureReport.maxBytes) -> String {
        var head = [summary, "", "launchctl: \(clean(launchctl))"]
        let d = detailLines
        if !d.isEmpty { head += ["", "Details:"] + d }
        var logLines = logged
        func build() -> String {
            (head + (logLines.isEmpty ? [] : ["", "Service log (newest lines):"] + logLines)).joined(separator: "\n")
        }
        while build().utf8.count > maxBytes, !logLines.isEmpty { logLines.removeFirst() }
        var text = build()
        if text.utf8.count > maxBytes {
            // Still too long with no log: cut the details' tail.
            while text.utf8.count > maxBytes - 3, !text.isEmpty { text.removeLast() }
            text += "…"
        }
        return text
    }
}
