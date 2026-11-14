import Foundation

/// Each pond's thread list as the Mac last sent it, kept per Mac so opening a pond draws its streams and threads in
/// the first frame and the Mac's fresh list replaces it in place (same ids, so rows do not rebuild). Same handling as
/// `SnapshotStore`: Caches, `.completeFileProtection`, excluded from backup, removed with the Mac, bounded.
public final class PondThreadsStore: @unchecked Sendable {
    public static let maxAge: TimeInterval = 7 * 24 * 3600
    public static let maxPonds = 20

    struct File: Codable { var v = 1; var ponds: [String: Held] }
    struct Held: Codable { var at: Double; var doc: PondThreads }

    private let url: URL
    private let queue = DispatchQueue(label: "squeak.pond-threads-store", qos: .utility)
    private let lock = NSLock()
    private var ponds: [String: Held] = [:]

    public init(directory: URL? = nil, name: String? = nil, now: Date = Date()) {
        let dir = directory ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        url = dir.appendingPathComponent("squeak-pondthreads\(name.map { "-" + $0 } ?? "").json")
        if let data = try? Data(contentsOf: url), let file = try? JSONDecoder().decode(File.self, from: data), file.v == 1 {
            ponds = file.ponds.filter { now.timeIntervalSince1970 - $0.value.at < Self.maxAge }
        }
    }

    public func load(_ pondId: String) -> PondThreads? { lock.lock(); defer { lock.unlock() }; return ponds[pondId]?.doc }

    public func record(_ doc: PondThreads, for pondId: String, now: Date = Date()) {
        lock.lock()
        if ponds[pondId]?.doc == doc { lock.unlock(); return }
        ponds[pondId] = Held(at: now.timeIntervalSince1970, doc: doc)
        if ponds.count > Self.maxPonds {
            for key in ponds.sorted(by: { $0.value.at < $1.value.at }).prefix(ponds.count - Self.maxPonds).map(\.key) { ponds[key] = nil }
        }
        let snapshot = ponds
        lock.unlock()
        queue.async { [url] in Self.write(snapshot, to: url) }
    }

    public func clear() {
        lock.lock(); ponds = [:]; lock.unlock()
        queue.async { [url] in try? FileManager.default.removeItem(at: url) }
    }

    /// Waits for pending writes; for tests.
    public func flush() { queue.sync {} }

    private static func write(_ ponds: [String: Held], to url: URL) {
        guard let data = try? JSONEncoder().encode(File(ponds: ponds)) else { return }
        var target = url
        try? FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        #if os(iOS)
        let options: Data.WritingOptions = [.atomic, .completeFileProtection]
        #else
        let options: Data.WritingOptions = [.atomic]
        #endif
        guard (try? data.write(to: target, options: options)) != nil else { return }
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try? target.setResourceValues(values)
    }
}

/// Which chats to warm in the background: the newest few that can page a delta, that are not warm already, only
/// when the phone is not saving power. Pure, so the bounds test without a phone.
public enum PrefetchPlan {
    public static let defaultLimit = 4
    /// A chat warmed this recently needs no warming.
    public static let freshFor: TimeInterval = 120

    public struct Candidate: Equatable, Sendable {
        public let key: String
        public let canDelta: Bool
        public let lastActivity: Date?
        public init(key: String, canDelta: Bool, lastActivity: Date?) { self.key = key; self.canDelta = canDelta; self.lastActivity = lastActivity }
        public init(key: String, canDelta: Bool, lastActivityAt: String) {
            self.init(key: key, canDelta: canDelta, lastActivity: ISO8601DateFormatter.squeakParse(lastActivityAt))
        }
    }

    /// Rows scrolled near the viewport may warm their chat too, under the same bounds plus a rate: at most `limit`
    /// warms in any `window` seconds, so a fast fling cannot start a request per row.
    public static let scrollWindow: TimeInterval = 10

    public static func scrollAllowed(key: String, canDelta: Bool, warmedAt: [String: Date], recentScrollWarms: [Date], now: Date = Date(),
                                     limit: Int = defaultLimit, lowPower: Bool, constrained: Bool = false, macReachable: Bool = true) -> Bool {
        guard canDelta, !lowPower, !constrained, macReachable else { return false }
        guard now.timeIntervalSince(warmedAt[key] ?? .distantPast) >= freshFor else { return false }
        return recentScrollWarms.filter { now.timeIntervalSince($0) < scrollWindow }.count < limit
    }

    /// Newest first, at most `limit`; nothing in Low Power Mode, on a constrained path, or while the Mac cannot answer.
    public static func keys(from candidates: [Candidate], warmedAt: [String: Date], now: Date = Date(), limit: Int = defaultLimit,
                            lowPower: Bool, constrained: Bool = false, macReachable: Bool = true) -> [String] {
        guard !lowPower, !constrained, macReachable, limit > 0 else { return [] }
        return candidates
            .filter { $0.canDelta && now.timeIntervalSince(warmedAt[$0.key] ?? .distantPast) >= freshFor }
            .sorted { ($0.lastActivity ?? .distantPast) > ($1.lastActivity ?? .distantPast) }
            .prefix(limit).map(\.key)
    }
}
