import Foundation

/// How a chat's transcript settles on its newest message when it opens. In a very tall lazy stack a plain
/// `scrollTo("bottom")` can land at an estimated offset where no row is realized, so the end sentinel never
/// appears and the view stays on a blank gap. This decides what to do next; the view only performs it.
public enum TranscriptSettle {
    public enum Action: Equatable, Sendable {
        /// Nothing to do yet (not measured, no rows, or the ordinary scroll is still being given a chance).
        case wait
        /// The newest end is on screen.
        case done
        /// Scroll to the last row anchored at the bottom (realizes real rows), then to the sentinel.
        case scrollToLastRow
        /// Retries are spent: stop settling and log it.
        case giveUp
    }

    public static let fallbackAfter: TimeInterval = 0.3
    public static let maxRetries = 3

    public static func next(viewportMeasured: Bool, rowCount: Int, atBottom: Bool, elapsed: TimeInterval, retries: Int) -> Action {
        guard viewportMeasured, rowCount > 0 else { return .wait }
        if atBottom { return .done }
        if elapsed < fallbackAfter { return .wait }
        return retries < maxRetries ? .scrollToLastRow : .giveUp
    }

    /// A paging anchor only holds while its row exists.
    public static func anchorToKeep(_ anchor: String?, rowIDs: [String]) -> String? {
        guard let anchor, rowIDs.contains(anchor) else { return nil }
        return anchor
    }

    /// Animate only a live append of one or two rows at the end; a whole-list replacement or tab switch never.
    public static func shouldAnimate(old: [String], new: [String]) -> Bool {
        guard !old.isEmpty, new.count > old.count, new.count - old.count <= 2 else { return false }
        return Array(new.prefix(old.count)) == old
    }
}
