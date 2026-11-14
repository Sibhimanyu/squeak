import Foundation
import os

/// Timing of the waits a person feels: cold launch to first content, opening a Mac, a pond, a chat, sending a reply.
/// Off unless `-squeak-perf` is a launch argument or `squeak.perf` is set in the defaults; when off, `begin` and
/// `end` cost a flag read. When on, each interval is an `os_signpost` (Instruments, "com.squeak.phone" / "perf") and
/// one line in the log (`PerfLog.lines`), so a run can be read without a profiler. The clock is injectable for tests.
public enum PerfMark: String, Sendable, CaseIterable {
    case launchToContent = "launch-to-content"
    case openMac = "open-mac"
    case openPond = "open-pond"
    case openChat = "open-chat"
    case sendReply = "send-reply"
    case prefetch = "prefetch"
}

public final class PerfLog: @unchecked Sendable {
    public static let shared = PerfLog(enabled: ProcessInfo.processInfo.arguments.contains("-squeak-perf")
                                       || UserDefaults.standard.bool(forKey: "squeak.perf"))

    public struct Interval: Equatable, Sendable {
        public let mark: PerfMark
        public let detail: String
        public let seconds: Double
        public let cached: Bool
    }

    public let enabled: Bool
    private let clock: @Sendable () -> TimeInterval
    private let signposter = OSSignposter(subsystem: "com.squeak.phone", category: "perf")
    private let logger = Logger(subsystem: "com.squeak.phone", category: "perf")
    private let lock = NSLock()
    private var open: [String: (start: TimeInterval, state: OSSignpostIntervalState)] = [:]
    private var done: [Interval] = []

    public init(enabled: Bool, clock: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.enabled = enabled
        self.clock = clock
    }

    private func id(_ mark: PerfMark, _ detail: String) -> String { mark.rawValue + "|" + detail }

    /// Starts an interval; a second `begin` of the same mark and detail keeps the first start.
    public func begin(_ mark: PerfMark, _ detail: String = "") {
        guard enabled else { return }
        lock.lock(); defer { lock.unlock() }
        let key = id(mark, detail)
        guard open[key] == nil else { return }
        open[key] = (clock(), signposter.beginInterval("wait", id: signposter.makeSignpostID(), "\(mark.rawValue, privacy: .public)"))
    }

    /// Ends it. `cached` says the first content came from the device, not the Mac.
    @discardableResult
    public func end(_ mark: PerfMark, _ detail: String = "", cached: Bool = false) -> Interval? {
        guard enabled else { return nil }
        lock.lock(); defer { lock.unlock() }
        guard let began = open.removeValue(forKey: id(mark, detail)) else { return nil }
        signposter.endInterval("wait", began.state)
        let interval = Interval(mark: mark, detail: detail, seconds: clock() - began.start, cached: cached)
        done.append(interval)
        if done.count > 200 { done.removeFirst(done.count - 200) }
        logger.info("\(mark.rawValue, privacy: .public) \(Int(interval.seconds * 1000), privacy: .public) ms\(cached ? " (cache)" : "", privacy: .public)")
        return interval
    }

    public var intervals: [Interval] { lock.lock(); defer { lock.unlock() }; return done }

    public var lines: [String] {
        intervals.map { "\($0.mark.rawValue) \(Int($0.seconds * 1000)) ms\($0.cached ? " cache" : "")" }
    }
}
