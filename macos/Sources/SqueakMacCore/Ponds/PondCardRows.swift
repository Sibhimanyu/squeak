import Foundation

/// Which of a stream card's threads show while it is collapsed: every one that is working, waiting on the person,
/// failed or unread, then the newest others until `minimum` rows are on show. Order is the caller's (newest first by
/// last activity); nothing is re-sorted by status.
public enum PondCardRows {
    public static let minimum = 3

    /// A thread that never folds away.
    public static func isActive(_ row: PondChatRow) -> Bool {
        if row.state != .finished { return true }
        guard let kind = row.mark?.kind else { return false }
        return kind == .working || kind == .waiting || kind == .failed || kind == .unread
    }

    public static func visible(threads: [PondChatRow], expanded: Bool, minimum: Int = PondCardRows.minimum) -> (rows: [PondChatRow], hiddenCount: Int) {
        guard !expanded, threads.count > minimum else { return (threads, 0) }
        var keep = Set(threads.indices.filter { isActive(threads[$0]) })
        for i in threads.indices where keep.count < minimum { keep.insert(i) }
        let rows = threads.indices.filter { keep.contains($0) }.map { threads[$0] }
        return (rows, threads.count - rows.count)
    }
}
