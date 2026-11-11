import Foundation

/// Guards that keep a measured size from feeding back into the layout that measured it.
public enum HeightGuard {
    /// A height is written to state only when it moved by more than this, so sub-point jitter never relayouts.
    public static let threshold: CGFloat = 0.5
    public static func shouldWrite(old: CGFloat, new: CGFloat) -> Bool { abs(new - old) > threshold }
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
