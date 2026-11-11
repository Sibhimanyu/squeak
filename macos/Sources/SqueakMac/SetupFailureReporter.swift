import Foundation
import Heresay
import os
import SqueakMacCore

/// When a setup step fails: one redacted line per fact into the unified log at `.error` (Heresay's trail picks
/// them up), one nudge per failure episode, and the text behind the "Send report" button.
@MainActor @Observable
final class SetupFailureReporter {
    static let shared = SetupFailureReporter()

    /// The latest failure's report, for the button; nil once setup works.
    private(set) var current: SetupFailureReport?
    @ObservationIgnored private var nudged = false
    @ObservationIgnored private let logger = Logger(subsystem: "com.squeak.mac", category: "app")

    func recovered() { current = nil; nudged = false }

    func record(step: String, reason: String, details: String?) {
        let logFile = LiveDaemonEffects.Paths.standard().logFile
        Task {
            let (launchctl, tail) = await Task.detached { (Self.launchctlSummary(), Self.tail(logFile)) }.value
            var details = details ?? ""
            let startup = LiveDaemonEffects.startupText()
            if !startup.isEmpty, !details.contains("startup.json:") { details += (details.isEmpty ? "" : "\n") + "startup.json: \(startup)" }
            let info = ProcessInfo.processInfo
            let v = info.operatingSystemVersion
            let report = SetupFailureReport(
                macOS: "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)",
                arch: LiveDaemonEffects.isAppleSilicon() ? "arm64" : "x86_64",
                appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown",
                step: step, reason: reason, details: details, launchctl: launchctl, logTail: tail,
                home: NSHomeDirectory())
            current = report
            // Already redacted; public so the unified log keeps the text Heresay reads.
            for line in report.logFacts { logger.error("\(line, privacy: .public)") }
            if SqueakMacApp.reportsEnabled, !nudged {
                nudged = true
                _ = Heresay.nudge()
            }
        }
    }

    nonisolated private static func tail(_ url: URL) -> [String] {
        guard let h = try? FileHandle(forReadingFrom: url) else { return [] }
        defer { try? h.close() }
        let size = (try? h.seekToEnd()) ?? 0
        try? h.seek(toOffset: size > 24_000 ? size - 24_000 : 0)
        let text = String(decoding: (try? h.readToEnd()) ?? Data(), as: UTF8.self)
        return Array(text.split(separator: "\n").suffix(SetupFailureReport.logLines).map(String.init))
    }

    nonisolated private static func launchctlSummary() -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = ["print", "gui/\(getuid())/com.squeak.daemon"]
        let out = Pipe()
        p.standardOutput = out; p.standardError = Pipe()
        guard (try? p.run()) != nil else { return "launchctl could not run" }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        if p.terminationStatus != 0 { return "not loaded (launchctl exit \(p.terminationStatus))" }
        let keys = ["state =", "pid =", "runs =", "last exit code =", "last terminating signal ="]
        let facts = String(decoding: data, as: UTF8.self).split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { l in keys.contains { l.hasPrefix($0) } }
        return facts.isEmpty ? "loaded" : facts.joined(separator: ", ")
    }
}
