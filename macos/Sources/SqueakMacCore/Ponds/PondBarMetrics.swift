import Foundation

/// The one top bar's rhythm (DESIGN.md spacing tokens: 4 / 8 / 12 / 16 / 24 / 32). Pure, so the numbers are tested and the
/// window reads as one grid: the bar's height is also the sidebar's top row, and the switch and the tabs share a height.
public enum PondBarMetrics {
    /// The bar's height, and the sidebar's top row beside it.
    public static let height = 56.0
    /// The Dashboard | Room switch and every tab: one height, so one capsule family.
    public static let controlHeight = 36.0
    /// Air above and below the controls.
    public static var verticalInset: Double { (height - controlHeight) / 2 }
    /// The Duck subheader under the bar, on the same surface.
    public static let subheaderHeight = 40.0
    /// The chat's soft top fade, so text never shows through behind the controls (no band edge, no hairline).
    public static let chatFadeHeight = 28.0
    /// The two rows together, which the quiet tint covers (its fade reaches a little past them).
    public static var surfaceHeight: Double { height + subheaderHeight }
    /// Both ends of the bar, matching the page content's inset (`Space.xl`).
    public static let endInset = 24.0
    /// Logo to name.
    public static let logoGap = 8.0
    /// Name to switch, and switch to the first tab (spacing alone, no divider).
    public static let sectionGap = 16.0
    /// Between tabs.
    public static let tabGap = 8.0
    /// Item tabs size to their content between these.
    public static let itemTabWidth: ClosedRange<Double> = 96...200
    /// A Duck's tab grows to its natural width up to this, then truncates.
    public static let duckTabMaxWidth = 280.0
    /// Clearance between the strip's last tab and the bar's menu / the rail.
    public static let trailingGap = 12.0

    /// The width an item tab takes: its content, never under the minimum or over the maximum.
    public static func itemTabWidth(content: Double) -> Double {
        min(max(content, itemTabWidth.lowerBound), itemTabWidth.upperBound)
    }

    /// A Duck tab's width: its natural width up to the maximum. The strip only shrinks tabs when the bar is full (`fit`).
    public static func duckTabWidth(natural: Double) -> Double { min(natural, duckTabMaxWidth) }

    /// Tab widths for a bar with `available` room: each at its natural width, shrunk together (never below `floor`) only when
    /// the total would overflow; past that the strip scrolls.
    public static func fit(natural: [Double], available: Double, floor: Double = 96) -> [Double] {
        let gaps = tabGap * Double(max(natural.count - 1, 0))
        let total = natural.reduce(0, +) + gaps
        guard total > available, !natural.isEmpty else { return natural }
        let scale = max((available - gaps) / natural.reduce(0, +), 0)
        return natural.map { max($0 * scale, min(floor, $0)) }
    }
}
