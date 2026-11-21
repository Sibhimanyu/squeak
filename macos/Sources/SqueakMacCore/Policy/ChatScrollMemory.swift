import Foundation

/// Where each chat was left, so coming back to it is not a jump to the newest message. Pure: the scroll driver saves a
/// `Snapshot` when the reader scrolls and when the chat goes away, and asks `resolve` what to do when it appears.
///
/// The anchor is the chat's first loaded row id plus the distance from the top: content that arrives at the end never
/// moves that distance, so a reader who was mid-scroll finds the same words in the same place. If the first row has
/// changed (older rows paged in above, the chat was rebuilt) the distance means something else, so the reader is put on
/// the newest end instead of somewhere arbitrary.
public struct ChatScrollMemory {
    public struct Snapshot: Equatable, Sendable {
        /// The newest end was followed when the chat was left.
        public var following: Bool
        /// Points between the top of the content and the top of the viewport.
        public var fromTop: Double
        /// The first and last row ids at that moment.
        public var firstRow: String?
        public var lastRow: String?

        public init(following: Bool, fromTop: Double, firstRow: String?, lastRow: String?) {
            self.following = following
            self.fromTop = fromTop
            self.firstRow = firstRow
            self.lastRow = lastRow
        }
    }

    public enum Resolution: Equatable, Sendable {
        /// Open on the newest end and keep following it.
        case follow
        /// Open this far from the top, not following; `newBelow`: rows arrived while the chat was away.
        case place(fromTop: Double, newBelow: Bool)
    }

    private var saved: KeyedLRU<String, Snapshot>

    public init(capacity: Int = 40) { saved = KeyedLRU(capacity: capacity) }

    public var count: Int { saved.count }

    public mutating func save(_ snapshot: Snapshot, for key: String) {
        saved.remove(key)
        _ = saved.value(for: key) { snapshot }
    }

    public mutating func snapshot(for key: String) -> Snapshot? {
        // A read counts as use, but must not invent an entry.
        guard saved.keys.contains(key) else { return nil }
        return saved.value(for: key) { Snapshot(following: true, fromTop: 0, firstRow: nil, lastRow: nil) }
    }

    public mutating func forget(_ key: String) { saved.remove(key) }

    /// What to do when a chat with these rows appears.
    public static func resolve(_ snapshot: Snapshot?, firstRow: String?, lastRow: String?) -> Resolution {
        guard let s = snapshot, !s.following, s.fromTop > 0, let first = s.firstRow, first == firstRow else { return .follow }
        return .place(fromTop: s.fromTop, newBelow: s.lastRow != lastRow)
    }
}
