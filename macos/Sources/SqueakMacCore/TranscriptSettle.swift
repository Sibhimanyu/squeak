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
        /// The time cap passed without reaching the end: scroll to the last row with no anchor, then to the
        /// sentinel, as a final try, and stop settling.
        case lastResort
        /// Never measured or no rows for the whole cap: stop settling and log it.
        case giveUp
    }

    public static let fallbackAfter: TimeInterval = 0.3
    /// Quick retries (each tick) right after the fallback delay.
    public static let maxRetries = 3
    /// After the quick ones, one retry this often while the end is still not on screen.
    public static let slowInterval: TimeInterval = 0.5
    /// Settling never runs longer than this, measured from when the viewport was measured (or from the start while it
    /// is not).
    public static let maxDuration: TimeInterval = 10

    /// `keepAnchor`: an earlier page is being kept in place (the person is reading up the chat), never yank them down.
    /// `total`: time since settling began, bounds the wait for a viewport or rows.
    public static func next(viewportMeasured: Bool, rowCount: Int, atBottom: Bool, elapsed: TimeInterval, retries: Int,
                            keepAnchor: Bool = false, total: TimeInterval = 0) -> Action {
        guard viewportMeasured, rowCount > 0 else { return total >= maxDuration ? .giveUp : .wait }
        if atBottom { return .done }
        if keepAnchor { return total >= maxDuration ? .giveUp : .wait }
        if elapsed >= maxDuration { return .lastResort }
        if elapsed < fallbackAfter { return .wait }
        if retries < maxRetries { return .scrollToLastRow }
        let due = fallbackAfter + slowInterval * Double(retries - maxRetries + 1)
        return elapsed >= due ? .scrollToLastRow : .wait
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
