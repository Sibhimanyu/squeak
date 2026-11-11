import Foundation

/// Why the background service did not start, kept in `daemon/failure.json` so a reopened setup still says why.
public struct DaemonFailure: Codable, Equatable, Sendable {
    public var version: String
    /// One plain sentence with what to do, for the setup screen.
    public var reason: String
    /// What a helper needs: the Mac, the Node check and what the service wrote while starting. Behind "Copy details".
    public var details: String

    public init(version: String, reason: String, details: String) {
        self.version = version; self.reason = reason; self.details = details
    }
}

/// What the app could see after a start that did not answer.
public struct DaemonEvidence: Equatable, Sendable {
    public var appleSilicon: Bool
    /// `node -v` from the installed copy: its exit code, or the signal that killed it.
    public var probeExit: Int32?
    public var probeSignal: Int32?
    public var probeTimedOut: Bool
    public var probeOutput: String
    /// What the service wrote to its log since this try began.
    public var log: String

    public init(appleSilicon: Bool = true, probeExit: Int32? = 0, probeSignal: Int32? = nil, probeTimedOut: Bool = false,
                probeOutput: String = "", log: String = "") {
        self.appleSilicon = appleSilicon; self.probeExit = probeExit; self.probeSignal = probeSignal
        self.probeTimedOut = probeTimedOut; self.probeOutput = probeOutput; self.log = log
    }
}

public enum DaemonDiagnosis {
    public static let slowStart = "The background service didn't answer in time. Security software can slow its first start, so wait a minute and try again."

    public static let intelReason = "Squeak's background service needs a Mac with Apple silicon (M1 or later), and this Mac has an Intel chip."

    public static func failure(_ e: DaemonEvidence, version: String) -> DaemonFailure {
        DaemonFailure(version: version, reason: reason(e), details: details(e, version: version))
    }

    public static func reason(_ e: DaemonEvidence) -> String {
        if !e.appleSilicon {
            return intelReason
        }
        if e.probeSignal == 9 {
            return "macOS stopped the background service from running. Security software or Gatekeeper usually does this: ask whoever manages this Mac to allow Squeak, then try again."
        }
        if e.probeTimedOut {
            return "macOS is still checking the background service before it runs. This can take a minute on a Mac with security software; try again shortly."
        }
        if e.probeSignal != nil || (e.probeExit ?? 1) != 0 {
            return "Squeak's background service files look damaged. Download Squeak again, replace the app, then try again."
        }
        let log = e.log
        if log.contains("EADDRINUSE") {
            return "Another app is already using Squeak's port (8477). Quit it, or restart the Mac, then try again."
        }
        if log.contains("NODE_MODULE_VERSION") || log.contains("dlopen") || log.contains("Cannot find module") {
            return "Squeak's background service files look damaged. Download Squeak again, replace the app, then try again."
        }
        if log.contains("EACCES") || log.contains("EPERM") || log.contains("Operation not permitted") {
            return "macOS refused the background service access to a file it needs. Try again; if it repeats, copy the details and send them to Squeak's support."
        }
        if let line = errorLine(log) {
            return "The background service stopped while starting: \(line)"
        }
        return slowStart
    }

    /// The first line that reads like the failure, short enough for one sentence.
    static func errorLine(_ log: String) -> String? {
        let lines = log.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        let hit = lines.first { l in
            l.contains(" ERROR ") || l.hasPrefix("Error") || l.contains("Error:") || l.hasPrefix("SqueakConfigError")
        }
        guard var line = hit, !line.isEmpty else { return nil }
        // Drop the logger's timestamp and level.
        if line.hasPrefix("["), let close = line.firstIndex(of: "]") { line = String(line[line.index(after: close)...]).trimmingCharacters(in: .whitespaces) }
        if line.hasPrefix("ERROR ") { line = String(line.dropFirst(6)) }
        if line.count > 160 { line = String(line.prefix(157)) + "…" }
        return line
    }

    public static func details(_ e: DaemonEvidence, version: String) -> String {
        var probe: String
        if e.probeTimedOut { probe = "timed out" }
        else if let s = e.probeSignal { probe = "killed by signal \(s)" }
        else if let c = e.probeExit { probe = "exit \(c)" }
        else { probe = "could not run" }
        let out = e.probeOutput.trimmingCharacters(in: .whitespacesAndNewlines)
        if !out.isEmpty { probe += ": \(out.prefix(300))" }
        let tail = e.log.split(separator: "\n", omittingEmptySubsequences: false).suffix(40).joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return """
        Background service \(version)
        Mac: \(e.appleSilicon ? "Apple silicon" : "Intel")
        node -v: \(probe)
        Log while starting:
        \(tail.isEmpty ? "(nothing written)" : tail)
        """
    }
}
