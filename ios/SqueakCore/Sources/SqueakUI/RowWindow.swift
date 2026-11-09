import Foundation

/// Which of a chat's rows are mounted. A long chat opens on its newest `initial` rows and mounts older ones in
/// batches as the reader nears the top, so what a chat costs to open does not grow with its length. The window is
/// anchored on the id of its first row, not a count: rows arriving at the end mount at once and nothing slides
/// out of the top under a reader. Pure: rows in, a slice out.
struct RowWindow: Equatable {
    /// Rows mounted when a chat opens, and rows added each time the reader nears the top.
    #if DEBUG
    /// `-squeak-old-open` measures the old way (every row mounted at once), for a before/after timing.
    static let initial = ProcessInfo.processInfo.arguments.contains("-squeak-old-open") ? 1_000_000 : 12
    #else
    static let initial = 12
    #endif
    static let batch = 15

    /// The id of the first mounted row; nil until the window has been placed on a chat's rows.
    private(set) var start: String?

    var placed: Bool { start != nil }

    /// Places the window on the newest `limit` of these rows. Does nothing once placed, or with no rows.
    mutating func place<Row: Identifiable>(_ rows: [Row], limit: Int = RowWindow.initial) where Row.ID == String {
        guard start == nil, !rows.isEmpty else { return }
        start = rows[max(0, rows.count - limit)].id
    }

    /// The window lost its first row (the rows were rebuilt without it): place it again on the newest rows.
    mutating func replaceIfLost<Row: Identifiable>(_ rows: [Row], limit: Int = RowWindow.initial) where Row.ID == String {
        guard let start, !rows.isEmpty, !rows.contains(where: { $0.id == start }) else { return }
        self.start = nil
        place(rows, limit: limit)
    }

    /// The mounted rows: from the first one to the end.
    func slice<Row: Identifiable>(_ rows: [Row], limit: Int = RowWindow.initial) -> ArraySlice<Row> where Row.ID == String {
        if let start, let index = rows.firstIndex(where: { $0.id == start }) { return rows[index...] }
        // Not placed yet (the first pass): the newest rows, the same ones `place` picks.
        return rows.suffix(limit)
    }

    /// How many rows are above the window, not mounted.
    func hidden<Row: Identifiable>(_ rows: [Row], limit: Int = RowWindow.initial) -> Int where Row.ID == String {
        rows.count - slice(rows, limit: limit).count
    }

    /// Mounts `count` older rows. Returns whether anything was added.
    @discardableResult
    mutating func grow<Row: Identifiable>(_ rows: [Row], by count: Int = RowWindow.batch) -> Bool where Row.ID == String {
        guard let start, let index = rows.firstIndex(where: { $0.id == start }), index > 0 else { return false }
        self.start = rows[max(0, index - count)].id
        return true
    }
}
