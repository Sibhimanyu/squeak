import Foundation

/// DESIGN.md §8.10: the workbench's panes are resizable, the sidebar 200–360 (default 256) and the inspector 280–560, and the
/// widths are remembered. Until the person drags, the inspector takes 30% of what the sidebar leaves (the centre 70%). The centre never gets squeezed below what a chat needs, so a wide pane yields to it.
public enum PaneWidths {
    public static let sidebarRange: ClosedRange<Double> = 200...360
    public static let inspectorRange: ClosedRange<Double> = 280...560
    public static let sidebarDefault: Double = 256
    /// The inspector's fallback when the window size is not known (a fixed width; `inspectorDefault(window:sidebar:)` is the real one).
    public static let inspectorDefault: Double = 340
    /// The share of the area right of the sidebar the inspector takes by default, so the centre keeps 70%.
    public static let inspectorShare: Double = 0.30

    /// The inspector's width before the person has dragged it: its share of the room beside the sidebar (`sidebar` 0 when
    /// the sidebar is hidden), within its range.
    public static func inspectorDefault(window: Double, sidebar: Double) -> Double {
        guard window.isFinite, window > 0 else { return inspectorDefault }
        let room = max(0, window - max(0, sidebar))
        return min(max((room * inspectorShare).rounded(), inspectorRange.lowerBound), inspectorRange.upperBound)
    }
    /// The narrowest the chat column may be made by the panes (the window's own minimum is 960).
    public static let centreMin: Double = 420

    /// A stored or dragged width brought into range; garbage (NaN, a missing default of 0) becomes `fallback`.
    public static func clamp(_ width: Double, _ range: ClosedRange<Double>, fallback: Double) -> Double {
        guard width.isFinite, width > 0 else { return fallback }
        return min(max(width, range.lowerBound), range.upperBound)
    }

    /// The width a pane may have now: its range, held back so the centre keeps `centreMin` beside `otherPane`
    /// (the other pane's width, 0 when it is closed). Never below the range's own minimum.
    public static func limit(range: ClosedRange<Double>, window: Double, otherPane: Double) -> Double {
        max(range.lowerBound, min(range.upperBound, window - otherPane - centreMin))
    }

    /// The width to draw: the remembered one, clamped to its range and to what the window leaves.
    public static func effective(_ stored: Double, range: ClosedRange<Double>, fallback: Double, window: Double, otherPane: Double) -> Double {
        min(clamp(stored, range, fallback: fallback), limit(range: range, window: window, otherPane: otherPane))
    }

    /// A drag's new width: where it started plus how far it moved (`grewToward` +1 when moving right grows the pane,
    /// the sidebar; −1 the inspector, which grows to the left), clamped.
    public static func dragged(start: Double, translation: Double, grewToward: Double, range: ClosedRange<Double>, window: Double, otherPane: Double) -> Double {
        let cap = limit(range: range, window: window, otherPane: otherPane)
        return min(max(start + translation * grewToward, range.lowerBound), cap)
    }
}
