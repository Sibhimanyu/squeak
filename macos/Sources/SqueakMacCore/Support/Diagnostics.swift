import CryptoKit
import Foundation

/// A bounded, thread-safe, in-memory log. Never persisted.
public final class LogBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []
    private let capacity: Int

    public init(capacity: Int = 200) { self.capacity = capacity }

    public func append(_ line: String, at date: Date = Date()) {
        let stamp = ISO8601DateFormatter().string(from: date)
        lock.withLock {
            lines.append("\(stamp) \(line)")
            if lines.count > capacity { lines.removeFirst(lines.count - capacity) }
        }
    }

    public func last(_ n: Int) -> [String] { lock.withLock { Array(lines.suffix(n)) } }
}

/// Removes anything identifying from text bound for a diagnostics report.
public enum DiagnosticsRedactor {
    /// First 8 hex characters of SHA-256: enough to tell two ids apart, not to recover one.
    public static func hash(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).prefix(4).map { String(format: "%02x", $0) }.joined()
    }

    private static let rules: [(NSRegularExpression, String)] = {
        func re(_ p: String) -> NSRegularExpression { try! NSRegularExpression(pattern: p) }
        return [
            (re(#"https?://[^\s"')]+"#), "<url>"),
            (re(#"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"#), "<email>"),
            (re(#"(?:~|/Users/[^/\s]+|/[A-Za-z0-9._-]+)(?:/[^\s"',;)]*)+"#), "<path>"),
            (re(#"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"#), "<id>"),
            (re(#"\b[A-Za-z0-9_\-+/=]{24,}\b"#), "<redacted>"),
            (re(#"(?i)\b(token|secret|password|authorization|bearer)\b\s*[:=]\s*\S+"#), "$1=<redacted>"),
        ]
    }()

    /// Redacts one line: URLs, e-mails, paths, UUIDs and long token-like strings.
    public static func redact(_ line: String) -> String {
        var out = line
        for (re, template) in rules {
            out = re.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out), withTemplate: template)
        }
        return out
    }
}

public struct DiagnosticsInput: Sendable {
    public struct Adapter: Sendable {
        public var name: String
        public var status: String
        public var lastSyncedAt: Date?
        public init(name: String, status: String, lastSyncedAt: Date?) {
            self.name = name; self.status = status; self.lastSyncedAt = lastSyncedAt
        }
    }
    public var appVersion: String
    public var osVersion: String
    public var adapters: [Adapter]
    public var stateCounts: [SessionState: Int]
    public var lastUpdateCheck: Date?
    public var logLines: [String]
    /// The newest lines of `updates.log` (already plain wording and versions).
    public var updateLogLines: [String]
    public var now: Date

    public init(
        appVersion: String, osVersion: String, adapters: [Adapter], stateCounts: [SessionState: Int],
        lastUpdateCheck: Date?, logLines: [String], updateLogLines: [String] = [], now: Date = Date()
    ) {
        self.updateLogLines = updateLogLines
        self.appVersion = appVersion; self.osVersion = osVersion; self.adapters = adapters
        self.stateCounts = stateCounts; self.lastUpdateCheck = lastUpdateCheck; self.logLines = logLines; self.now = now
    }

    public static func counts(of sessions: [HostSession]) -> [SessionState: Int] {
        Dictionary(sessions.map { ($0.state, 1) }, uniquingKeysWith: +)
    }

    public static func describe(_ status: ConnectionStatus) -> String {
        switch status {
        case .connected: "connected"
        case .daemonDown: "daemon down"
        case .tokenMissing: "token missing"
        case .degraded: "degraded"   // the reason can carry a path; counts and states only
        }
    }
}

public enum DiagnosticsReport {
    /// Plain text. Holds versions, adapter status, counts by state, times and
    /// redacted log lines. It cannot hold titles, paths, ids, tokens or message
    /// text because none of those are inputs.
    public static func render(_ input: DiagnosticsInput) -> String {
        let iso = ISO8601DateFormatter()
        func time(_ d: Date?) -> String { d.map(iso.string(from:)) ?? "never" }
        var out = [
            "Squeak diagnostics",
            "Generated: \(iso.string(from: input.now))",
            "App version: \(input.appVersion)",
            "macOS: \(input.osVersion)",
            "",
            "Sources",
        ]
        for a in input.adapters { out.append("  \(a.name): \(a.status), last sync \(time(a.lastSyncedAt))") }
        out.append("")
        out.append("Sessions by state")
        let order: [SessionState] = [.working, .blocked, .finished, .idle, .error, .unknown]
        for s in order { out.append("  \(s.rawValue): \(input.stateCounts[s] ?? 0)") }
        out.append("")
        out.append("Last update check: \(time(input.lastUpdateCheck))")
        out.append("")
        out.append("Log (last \(min(50, input.logLines.count)) lines, redacted)")
        for l in input.logLines.suffix(50) { out.append("  " + DiagnosticsRedactor.redact(l)) }
        out.append("")
        out.append("Update log (last \(min(80, input.updateLogLines.count)) lines, redacted)")
        for l in input.updateLogLines.suffix(80) { out.append("  " + DiagnosticsRedactor.redact(l)) }
        return out.joined(separator: "\n")
    }
}
