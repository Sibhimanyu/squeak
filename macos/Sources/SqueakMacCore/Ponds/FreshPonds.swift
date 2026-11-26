import Foundation

/// Ponds this Mac just made (a folder opened, a repository cloned) that the pond directory has not listed yet.
/// The host lists a project the moment it exists, but the Mac's copy of the directory is a read taken earlier (or
/// one still in flight), and "a loaded directory without this pond" means the pond is gone: its page draws nothing and
/// every place that pointed at it (a New duck page, the Dashboard of the new pond) falls back to the global Dashboard.
/// Until the directory lists a fresh pond, or the grace runs out, it counts as live; after that only the directory decides.
public struct FreshPonds: Sendable, Equatable {
    public static let grace: TimeInterval = 120

    private var made: [String: Date] = [:]

    public init() {}

    public mutating func add(_ key: String, at: Date) { made[key] = at }

    /// The keys held live now.
    public func keys(now: Date) -> Set<String> {
        Set(made.filter { now.timeIntervalSince($0.value) < Self.grace }.keys)
    }

    /// The keys a loaded directory's `live` set is read against: the directory's own, plus the fresh ones. A nil `live`
    /// (not loaded) stays nil: nothing is pruned.
    public func live(directory live: Set<String>?, now: Date) -> Set<String>? {
        live.map { $0.union(keys(now: now)) }
    }

    /// Drops ponds the directory now lists, and those past the grace.
    public mutating func prune(listed: Set<String>, now: Date) {
        made = made.filter { !listed.contains($0.key) && now.timeIntervalSince($0.value) < Self.grace }
    }
}
