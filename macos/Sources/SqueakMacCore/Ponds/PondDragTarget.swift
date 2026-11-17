import Foundation

/// Where a dragged pond would land, worked out from the pointer over a row. Pure: the sidebar only draws it.
public enum PondDragTarget {
    /// The insertion slot, 0...shown.count, for a pointer at `y` (0 = top) over the row at `rowIndex`, `rowHeight` tall:
    /// the top half is before the row, the bottom half after it.
    public static func slot(rowIndex: Int, y: Double, rowHeight: Double) -> Int {
        rowHeight > 0 && y > rowHeight / 2 ? rowIndex + 1 : rowIndex
    }

    /// The key a drop at `slot` goes before (nil: after the last), the shape `PondOrder.moved` takes.
    public static func before(slot: Int, shown: [String]) -> String? {
        slot >= 0 && slot < shown.count ? shown[slot] : nil
    }

    /// The slot to open a gap at, or nil when dropping there changes nothing (just above or below the dragged row itself).
    public static func gap(slot: Int, moving: String, shown: [String]) -> Int? {
        guard let from = shown.firstIndex(of: moving), slot >= 0, slot <= shown.count else { return slot }
        return slot == from || slot == from + 1 ? nil : slot
    }
}
