import Foundation

/// A small plain-text log of everything the update logic does, at `~/Library/Logs/Squeak Mac/updates.log`.
/// The unified log is private on a real Mac, so when an update misbehaves this file is the only record:
/// every Sparkle callback, state change, timeout, quit decision and relaunch-watchdog step lands here.
/// Only wording and versions go in (error text passes through `DiagnosticsRedactor`, which drops paths,
/// URLs, ids and token-like strings). The file is capped: past `capBytes` the oldest lines are dropped.
public final class UpdateLog: @unchecked Sendable {
    public static let defaultCapBytes = 200_000

    /// The app's one update log. Off outside the real app bundle, so tests, `swift run`, captures and the demo never write it.
    public static let standard: UpdateLog = {
        let env = ProcessInfo.processInfo.environment
        let real = Bundle.main.bundleIdentifier == "com.squeak.mac" && env["SQUEAK_MAC_CAPTURE"] == nil && env["SQUEAK_MAC_DEMO"] == nil
        return UpdateLog(url: defaultURL, enabled: real)
    }()

    public static var defaultURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/Squeak Mac", isDirectory: true)
            .appendingPathComponent("updates.log")
    }

    public let url: URL
    public let isEnabled: Bool
    private let capBytes: Int
    private let now: @Sendable () -> Date
    private let lock = NSLock()

    public init(url: URL, capBytes: Int = UpdateLog.defaultCapBytes, enabled: Bool = true, now: @escaping @Sendable () -> Date = { Date() }) {
        self.url = url; self.capBytes = capBytes; self.isEnabled = enabled; self.now = now
    }

    /// Appends one line: `2026-10-30T12:00:00+0530 message`. Never throws; a log that cannot be written is simply lost.
    public func write(_ message: String) {
        guard isEnabled else { return }
        var text = DiagnosticsRedactor.redact(message.replacingOccurrences(of: "\n", with: " "))
        if text.count > 400 { text = String(text.prefix(400)) + "…" }
        let line = Self.stamp(now()) + " " + text + "\n"
        lock.withLock {
            let fm = FileManager.default
            try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            if !fm.fileExists(atPath: url.path) { fm.createFile(atPath: url.path, contents: nil) }
            guard let handle = try? FileHandle(forWritingTo: url) else { return }
            defer { try? handle.close() }
            let size = (try? handle.seekToEnd()) ?? 0
            try? handle.write(contentsOf: Data(line.utf8))
            if Int(size) + line.utf8.count > capBytes { trim() }
        }
    }

    /// The newest `n` lines, oldest first.
    public func tail(_ n: Int) -> [String] {
        lock.withLock {
            guard let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8) else { return [] }
            return Array(text.split(separator: "\n", omittingEmptySubsequences: true).suffix(n)).map(String.init)
        }
    }

    /// Keeps roughly the newest 60% of the cap, starting on a line boundary. Caller holds the lock.
    private func trim() {
        guard let data = try? Data(contentsOf: url) else { return }
        let keep = capBytes * 6 / 10
        guard data.count > keep else { return }
        var tail = data.suffix(keep)
        if let nl = tail.firstIndex(of: 0x0A) { tail = tail[tail.index(after: nl)...] }
        try? Data(tail).write(to: url, options: .atomic)
    }

    static func stamp(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ssZ"
        return f.string(from: date)
    }
}
