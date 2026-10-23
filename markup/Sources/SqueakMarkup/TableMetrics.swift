import CoreGraphics

/// How a table's columns share a width. Pure arithmetic so it is tested without a screen:
/// the layout measures every cell (its one-line width and its longest unbreakable word)
/// and this decides the column widths.
public enum TableMetrics {
    /// No column takes more than this share of the width unless the table scrolls.
    public static let columnCap: CGFloat = 0.6
    /// A column is not squeezed below this (or its own content, if narrower).
    public static let readableMinimum: CGFloat = 64
    /// In a scrolling table a column is at most this wide, so a long one still wraps.
    public static let scrollColumnMaximum: CGFloat = 240

    public struct Columns: Equatable, Sendable {
        public var widths: [CGFloat]
        /// The columns are wider than the space: the table must scroll sideways.
        public var scrolls: Bool
        public var total: CGFloat { widths.reduce(0, +) }
    }

    /// `ideal`: each column's widest cell on one line. `minimum`: its widest cell's longest
    /// word. `available`: the width the table may use, nil when unknown (ideal widths).
    public static func columns(ideal: [CGFloat], minimum: [CGFloat], available: CGFloat?) -> Columns {
        let n = ideal.count
        guard n > 0 else { return Columns(widths: [], scrolls: false) }
        let ideal = ideal.map { max($0, 0) }
        let floors: [CGFloat] = (0..<n).map { i in
            let word = i < minimum.count ? max(minimum[i], 0) : 0
            return min(ideal[i], max(word, readableMinimum))
        }
        guard let available, available.isFinite, available > 0 else {
            return Columns(widths: ideal, scrolls: false)
        }
        let sumIdeal = ideal.reduce(0, +)
        if sumIdeal <= available {
            return Columns(widths: fill(ideal, weights: ideal, to: available), scrolls: false)
        }
        let sumFloors = floors.reduce(0, +)
        if sumFloors > available {
            // Too many columns to read side by side: each keeps a readable width and the table scrolls.
            let widths = (0..<n).map { max(floors[$0], min(ideal[$0], scrollColumnMaximum)) }
            return Columns(widths: widths, scrolls: true)
        }
        // A long column wraps rather than pushing the others off screen.
        let wanted = (0..<n).map { max(min(ideal[$0], columnCap * available), floors[$0]) }
        let sumWanted = wanted.reduce(0, +)
        if sumWanted <= available {
            return Columns(widths: fill(wanted, weights: (0..<n).map { ideal[$0] - wanted[$0] + 1 }, to: available), scrolls: false)
        }
        let room = available - sumFloors
        let want = sumWanted - sumFloors
        let widths = (0..<n).map { floors[$0] + (want > 0 ? room * (wanted[$0] - floors[$0]) / want : 0) }
        return Columns(widths: widths, scrolls: false)
    }

    /// Hands any spare width to the columns in proportion to `weights`, so the table fills its box.
    private static func fill(_ widths: [CGFloat], weights: [CGFloat], to available: CGFloat) -> [CGFloat] {
        let spare = available - widths.reduce(0, +)
        let total = weights.reduce(0, +)
        guard spare > 0, total > 0 else { return widths }
        return (0..<widths.count).map { widths[$0] + spare * weights[$0] / total }
    }
}

public extension MessageMarkup {
    /// The words of an inline run without any markup, for VoiceOver and measuring.
    static func plainText(_ inlines: [Inline]) -> String {
        inlines.map { inline -> String in
            switch inline {
            case .text(let s), .code(let s), .url(let s), .path(let s): return s
            case .bold(let i), .italic(let i), .strike(let i): return plainText(i)
            case .link(let label, _): return plainText(label)
            }
        }.joined()
    }
}
