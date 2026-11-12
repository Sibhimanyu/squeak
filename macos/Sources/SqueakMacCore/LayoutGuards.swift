import Foundation

/// Guards that keep a measured size from feeding back into the layout that measured it.
public enum HeightGuard {
    /// A height is written to state only when it moved by more than this, so sub-point jitter never relayouts.
    public static let threshold: CGFloat = 0.5
    public static func shouldWrite(old: CGFloat, new: CGFloat) -> Bool { abs(new - old) > threshold }
}

/// The least height of the transcript's scroll content, so a short chat sits on the composer.
public enum TranscriptMinHeight {
    /// `viewport` is the ScrollView's own measured height. The dock is a `.safeAreaInset` on that ScrollView, and a
    /// ScrollView measured inside it already excludes the inset (measured: 600 pt host, 100 pt dock reads 500), so
    /// the dock is never subtracted again; doing so left a short chat one dock-height too short.
    public static func value(viewport: CGFloat) -> CGFloat { max(0, viewport).rounded() }
}

/// A constant-size stand-in for the transcript's row ids, for `onChange` and `animation(value:)`: building the
/// whole id array on every body pass is O(n), and a token changes exactly when rows are added, removed or replaced
/// at the ends.
public struct RowsToken: Equatable, Sendable {
    public let count: Int
    public let first: String?
    public let last: String?
    public init(ids: [String]) { count = ids.count; first = ids.first; last = ids.last }
    public init(count: Int, first: String?, last: String?) { self.count = count; self.first = first; self.last = last }

    /// Whether the step from `old` to `new` is a live append of one or two rows at the end (animated).
    public static func isLiveAppend(old: RowsToken, new: RowsToken) -> Bool {
        old.count > 0 && new.count > old.count && new.count - old.count <= 2 && old.first == new.first
    }
}

/// Publishes a value only when it differs, so SwiftUI is not invalidated by an identical poll.
public func publishIfChanged<T: Equatable>(_ current: inout T, _ fresh: T) -> Bool {
    guard current != fresh else { return false }
    current = fresh
    return true
}

/// The transcript column's width from the container, read once and passed down, so the stack under the scroll view is
/// proposed one exact width instead of being measured at its ideal size (which typesets every message again).
public enum TranscriptColumn {
    /// The column's width for a container `container` wide, capped at `cap`; nil until the container has been measured
    /// (the caller then falls back to a flexible cap). Whole points, so sub-point jitter never changes it.
    public static func fixedWidth(container: CGFloat, cap: CGFloat) -> CGFloat? {
        guard container > 1 else { return nil }
        return min(container, cap).rounded(.down)
    }
}

/// Typeset heights by (message id, content hash, width), for layouts whose height is a pure function of those. A
/// relayout at the same width reads this instead of typesetting the text again; a changed text or width is a new key.
public final class TextHeightCache: @unchecked Sendable {
    public struct Key: Hashable, Sendable {
        public let id: String
        public let content: Int
        public let width: Int
        public init(id: String, content: Int, width: CGFloat) { self.id = id; self.content = content; self.width = Int(width.rounded()) }
    }

    private let lock = NSLock()
    private var heights: [Key: CGFloat] = [:]
    private let limit: Int
    public init(limit: Int = 512) { self.limit = limit }
    public static let shared = TextHeightCache()

    public func height(for key: Key) -> CGFloat? { lock.lock(); defer { lock.unlock() }; return heights[key] }

    public func store(_ height: CGFloat, for key: Key) {
        lock.lock(); defer { lock.unlock() }
        if heights.count >= limit { heights.removeAll(keepingCapacity: true) }
        heights[key] = height
    }

    /// `height(for:)`, else `measure()` stored under the key.
    public func height(for key: Key, measure: () -> CGFloat) -> CGFloat {
        if let hit = height(for: key) { return hit }
        let h = measure()
        store(h, for: key)
        return h
    }
}
