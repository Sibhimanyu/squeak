import Foundation

/// Answers kept so a screen can show the last one at once and refresh behind it. Pure: the caller passes the
/// clock, so it tests without waiting. In memory only; `AppListFile` is the one that reaches disk.
public struct StaleCache<Key: Hashable & Sendable, Value: Sendable>: Sendable {
    public struct Entry: Sendable { public let value: Value; public let at: Date }
    private var entries: [Key: Entry] = [:]
    private var order: [Key] = []
    public let limit: Int

    public init(limit: Int = 32) { self.limit = max(1, limit) }

    public mutating func store(_ value: Value, for key: Key, at now: Date = Date()) {
        entries[key] = Entry(value: value, at: now)
        order.removeAll { $0 == key }
        order.append(key)
        while order.count > limit { entries[order.removeFirst()] = nil }
    }

    /// The last answer, however old.
    public func value(for key: Key) -> Value? { entries[key]?.value }

    /// Whether the answer for `key` is younger than `ttl`.
    public func isFresh(_ key: Key, ttl: TimeInterval, now: Date = Date()) -> Bool {
        guard let entry = entries[key] else { return false }
        return now.timeIntervalSince(entry.at) < ttl
    }

    public mutating func remove(_ key: Key) { entries[key] = nil; order.removeAll { $0 == key } }
    public mutating func removeAll() { entries = [:]; order = [] }
    public var count: Int { entries.count }
}

/// The Mac's installed-app list, kept in a small file in the Caches folder so the picker opens with something.
public enum AppListFile {
    public static func load(from url: URL) -> [PhoneSnapshot.MacApp]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode([PhoneSnapshot.MacApp].self, from: data)
    }

    public static func save(_ apps: [PhoneSnapshot.MacApp], to url: URL) {
        guard let data = try? JSONEncoder().encode(apps) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }
}

/// When a spinner has run long enough to say so, and a way out.
public enum WaitHint {
    /// After this long a wait says "Still waiting…" and offers Cancel.
    public static let after: TimeInterval = 8
    public static let line = "Still waiting for your Mac…"

    public static func isLong(since start: Date, now: Date = Date()) -> Bool { now.timeIntervalSince(start) >= after }
}
