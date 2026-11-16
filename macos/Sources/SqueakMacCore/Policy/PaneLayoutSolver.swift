import Foundation

/// The one place pane widths are decided. Widths drawn always come from here, never straight from stored values, so the
/// sidebar, centre and right zone can never add up to more than the window.
/// Priority: the centre keeps `centreMin`; the right zone gives way first (down to its minimum), then the sidebar (to its
/// minimum); if the window is still too narrow the right zone is hidden, then the sidebar.
public enum PaneLayoutSolver {
    public struct Pane: Equatable, Sendable {
        public var shown: Bool
        public var preferred: Double
        public var range: ClosedRange<Double>
        public init(shown: Bool, preferred: Double, range: ClosedRange<Double>) {
            self.shown = shown; self.preferred = preferred; self.range = range
        }
    }

    public struct Result: Equatable, Sendable {
        public var sidebar: Double
        public var centre: Double
        public var right: Double
        public var sidebarShown: Bool
        public var rightShown: Bool
    }

    public static func solve(window: Double, sidebar: Pane, right: Pane, centreMin: Double = PaneWidths.centreMin) -> Result {
        let w = (window.isFinite && window > 0) ? window : 0
        var showSide = sidebar.shown, showRight = right.shown
        func want(_ p: Pane) -> Double { PaneWidths.clamp(p.preferred, p.range, fallback: p.range.lowerBound) }
        var s = showSide ? want(sidebar) : 0
        var r = showRight ? want(right) : 0
        // Everything above the centre's minimum is room the panes may take; the right zone yields first.
        var over = s + r + centreMin - w
        if over > 0, showRight { let cut = min(over, r - right.range.lowerBound); r -= cut; over -= cut }
        if over > 0, showSide { let cut = min(over, s - sidebar.range.lowerBound); s -= cut; over -= cut }
        if over > 0, showRight { showRight = false; r = 0; over = s + centreMin - w }
        if over > 0, showSide { showSide = false; s = 0 }
        return Result(sidebar: s, centre: max(0, w - s - r), right: r, sidebarShown: showSide, rightShown: showRight)
    }

    /// The most a pane may be dragged to now: what the window leaves beside the other pane (at its current, solved width),
    /// never below its own minimum.
    public static func dragMax(window: Double, otherPane: Double, range: ClosedRange<Double>, centreMin: Double = PaneWidths.centreMin) -> Double {
        max(range.lowerBound, min(range.upperBound, window - otherPane - centreMin))
    }

    /// The narrowest content the window may have: sidebar min + centre min (+ right min when shown).
    public static func minimumWindowWidth(sidebarShown: Bool, rightShown: Bool, centreMin: Double = PaneWidths.centreMin) -> Double {
        centreMin + (sidebarShown ? PaneWidths.sidebarRange.lowerBound : 0) + (rightShown ? PaneWidths.inspectorRange.lowerBound : 0)
    }

    /// The bottom zone's height for a column `column` high (same rule as the widths: clamped, never past the limit).
    public static func bottomHeight(stored: Double, column: Double) -> Double { TerminalPanelSizing.clamp(stored, column: column) }
}
