import Foundation

/// DESIGN.md §8.10, the terminal panel: it sits at the bottom of the centre column, 120pt tall at least and 60% of
/// the column at most, and its height is remembered. Same shape as `PaneWidths`, vertical.
public enum TerminalPanelSizing {
    public static let minHeight: Double = 120
    public static let maxFraction: Double = 0.6
    public static let defaultHeight: Double = 240

    /// The tallest the panel may be in a column `column` points high; never below the minimum.
    public static func limit(column: Double) -> Double {
        guard column.isFinite, column > 0 else { return minHeight }
        return max(minHeight, column * maxFraction)
    }

    /// A stored or dragged height brought into range; garbage (NaN, 0 from an unset default) becomes the default.
    public static func clamp(_ height: Double, column: Double) -> Double {
        let h = (height.isFinite && height > 0) ? height : defaultHeight
        return min(max(h, minHeight), limit(column: column))
    }

    /// A drag's new height: where it started, grown by moving the handle up. `translation` is the pointer's
    /// downward distance in window coordinates, so dragging up (negative) makes the panel taller.
    public static func dragged(start: Double, translation: Double, column: Double) -> Double {
        let raw = start - translation
        guard raw.isFinite else { return clamp(start, column: column) }
        return min(max(raw, minHeight), limit(column: column))
    }
}
