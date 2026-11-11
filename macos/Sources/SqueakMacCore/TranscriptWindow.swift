import Foundation

/// The transcript renders only a bounded window of its newest rows, in a plain (non-lazy) stack, so the layout of what is
/// on screen is exact and the bottom is always real content. A lazy stack of very tall rows estimates heights, and a
/// scroll to the end could land in an unrealized gap: a chat that opened blank. Older rows are paged in on demand.
///
/// The window is a start row id: appends at the end and older messages loaded in front never move it, so the window
/// grows with the chat and the reader is never shifted by anything but their own paging.
public enum TranscriptWindow {
    /// Rows shown when a chat opens.
    public static let initialCount = 40
    /// Rows added at the top each time the reader reaches it.
    public static let pageCount = 30

    /// Index of the first rendered row: the start id's row, else (no start yet, or its row is gone) the newest `initialCount`.
    public static func startIndex(rowIDs: [String], start: String?) -> Int {
        if let start, let i = rowIDs.firstIndex(of: start) { return i }
        return max(0, rowIDs.count - initialCount)
    }

    /// The rendered rows' indices into the full list.
    public static func visible(rowIDs: [String], start: String?) -> Range<Int> {
        startIndex(rowIDs: rowIDs, start: start)..<rowIDs.count
    }

    /// Older rows are already loaded but not rendered.
    public static func hasHidden(rowIDs: [String], start: String?) -> Bool { startIndex(rowIDs: rowIDs, start: start) > 0 }

    /// The start after paging `pageCount` older rows in, and the row to hold in place (the first one rendered before).
    /// Nil when nothing is hidden: the next page has to come from the host instead.
    public static func expanded(rowIDs: [String], start: String?) -> (start: String, anchor: String)? {
        let from = startIndex(rowIDs: rowIDs, start: start)
        guard from > 0 else { return nil }
        return (rowIDs[max(0, from - pageCount)], rowIDs[from])
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

/// What follows the newest end of the transcript: pinned while the reader is there, a "new below" cue when not.
public enum TranscriptPin {
    /// A change at the end (new row, state, streamed text) scrolls to the end when the reader is on it, or just sent.
    public static func followsEnd(atBottom: Bool, lastIsUserMessage: Bool) -> Bool { atBottom || lastIsUserMessage }

    /// A new row arrived out of view: the jump button says "New".
    public static func marksNewBelow(atBottom: Bool, lastIsUserMessage: Bool) -> Bool { !followsEnd(atBottom: atBottom, lastIsUserMessage: lastIsUserMessage) }

    /// The jump-to-newest button shows only while the end is out of view.
    public static func jumpButtonVisible(atBottom: Bool, rowCount: Int) -> Bool { !atBottom && rowCount > 0 }
}
