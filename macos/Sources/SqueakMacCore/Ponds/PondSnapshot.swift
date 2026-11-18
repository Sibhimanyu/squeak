import Foundation

// The Dashboard <-> Room slide as two bitmaps moved by Core Animation (like Safari's back swipe): the pure parts. Which
// page leaves and which arrives, where each snapshot layer sits, how dark its scrim is, which one is drawn on top, and
// whether the captures can be trusted. Both directions are the exact mirror of each other.
public enum PondSnapshotPlan {
    /// The page that arrives when `source` leaves.
    public static func destination(of source: PondPage) -> PondPage { source == .dashboard ? .room : .dashboard }

    /// Where a page's snapshot sits horizontally (points from the view's left edge) with the strip at `position`.
    public static func x(of page: PondPage, position: Double, width: Double) -> Double {
        PondDrag.x(of: page, position: position, width: width)
    }

    /// The flat dimming over a page that is leaving or arriving: none at rest, 28% a full width away.
    public static func scrim(x: Double, width: Double) -> Double {
        0.28 * min(1, abs(x) / max(1, width))
    }

    /// Stacking order: the page that is not at rest is always the one drawn on top, so the page that arrives slides over
    /// the one that leaves in both directions, never the other way round.
    public static func zPosition(of page: PondPage, rest: PondPage) -> Double { page == rest ? 0 : 1 }

    /// Snapshots are used only when both captures exist, the view has a size, and the two differ (a capture that did not see
    /// the staged page would be a copy of the other).
    public static func usable(width: Double, height: Double, capturedBoth: Bool, identical: Bool) -> Bool {
        width > 1 && height > 1 && capturedBoth && !identical
    }
}
