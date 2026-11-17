import Foundation

// The Dashboard <-> Room swipe as a gesture the pages follow (DESIGN.md §7): pure, so the view only draws what comes back.

/// Follows one two-finger gesture. `feed` returns what the view should do: follow the fingers, complete the switch, or
/// settle back. Fingers right = positive offset (the Dashboard comes in from the left), fingers left = negative.
public struct PondDrag: Sendable, Equatable {
    public enum Update: Sendable, Equatable {
        /// Draw the pages at this signed offset (points the current page has moved).
        case track(Double)
        /// The gesture ended past the threshold: slide on to this page from the current offset.
        case commit(PondPage)
        /// The gesture ended short, or turned into a scroll: ease back to rest.
        case settle
    }

    /// Fingers' travel to page travel.
    public static let ratio = 0.5
    /// Most the pages follow, as a share of the width.
    public static let maxShare = 0.4
    /// Resistance where there is no page: a third of the following, and at most this share of the width.
    public static let endResistance = 0.3
    public static let endMaxShare = 0.06

    private var x = 0.0
    private var y = 0.0
    private var active = false
    private var spent = false
    private var moved = false

    public init() {}

    /// Signed page offset for the fingers' horizontal travel `delta` on `page` of a view `width` wide.
    public static func offset(delta: Double, width: Double, page: PondPage) -> Double {
        guard width > 0 else { return 0 }
        let hasPage = page == .dashboard ? delta < 0 : delta > 0
        let raw = delta * ratio * (hasPage ? 1 : endResistance)
        let cap = width * (hasPage ? maxShare : endMaxShare)
        return max(-cap, min(cap, raw))
    }

    /// How far toward the other page, 0...1 (0 at the ends, where there is none).
    public static func progress(offset: Double, width: Double, page: PondPage) -> Double {
        guard width > 0 else { return 0 }
        let toward = page == .dashboard ? -offset : offset
        return max(0, min(1, toward / (width * maxShare)))
    }

    /// Where a page sits and how visible it is at `offset`. At rest: the current page at 0, the other a width away, hidden.
    /// While dragging toward the other page, it fades in and closes the distance as it does.
    public static func layout(of page: PondPage, current: PondPage, offset: Double, width: Double) -> (x: Double, opacity: Double) {
        let p = progress(offset: offset, width: width, page: current)
        if page == current { return (offset, 1 - 0.5 * p) }
        let side = page == .room ? 1.0 : -1.0
        return (side * width * (1 - p), p)
    }

    public mutating func reset() { x = 0; y = 0; active = false; spent = false; moved = false }

    /// One scroll event. `dx`/`dy` follow the fingers (negative dx = fingers moved left). Inertia is ignored.
    public mutating func feed(dx: Double, dy: Double, phase: PondSwipe.Phase, momentum: Bool, current: PondPage, width: Double) -> Update? {
        if momentum { return nil }
        switch phase {
        case .none: return nil
        case .began: reset(); active = true
        case .cancelled:
            let was = moved; reset()
            return was ? .settle : nil
        case .ended:
            let decided = decision(current: current)
            let was = moved; reset()
            if let page = decided { return .commit(page) }
            return was ? .settle : nil
        case .changed:
            if !active { reset(); active = true }
        }
        guard active, !spent else { return nil }
        x += dx; y += dy
        if abs(y) > abs(x) * PondSwipe.dominance, abs(y) > 12 {
            spent = true
            let was = moved; moved = false
            return was ? .settle : nil
        }
        guard abs(x) >= 4 else { return nil }
        moved = true
        return .track(Self.offset(delta: x, width: width, page: current))
    }

    /// The page the gesture's final state chooses, nil when it chose none (short, vertical, or the page already shown).
    private func decision(current: PondPage) -> PondPage? {
        guard active, !spent, abs(x) >= PondSwipe.threshold, abs(x) >= abs(y) * PondSwipe.dominance else { return nil }
        let target: PondPage = x < 0 ? .room : .dashboard
        return target == current ? nil : target
    }
}

/// The edge hint: when it nudges and whether it still says the word. Counts live in UserDefaults; this decides.
public struct PondSwipeHint: Sendable, Equatable {
    public static let nudgeVisits = 3
    public static let wordSwipes = 3
    /// Points the chevron drifts, out and back, twice.
    public static let nudgeDistance = 6.0
    public static let nudgeRepeats = 2
    public static let nudgeDelay = 1.5

    /// Visits to a pond view so far, this one included.
    public var visits: Int
    /// Successful swipes in total.
    public var swipes: Int

    public init(visits: Int = 0, swipes: Int = 0) { self.visits = visits; self.swipes = swipes }

    /// Only the first few visits nudge, and never under Reduce Motion.
    public func nudges(reduceMotion: Bool) -> Bool { !reduceMotion && visits <= Self.nudgeVisits }
    /// The word goes once the person has swiped a few times; the faint chevron stays.
    public var showsWord: Bool { swipes < Self.wordSwipes }
    /// How much the hint stretches toward the swipe at `progress` (0...1): up to 18%.
    public static func stretch(progress: Double) -> Double { 1 + 0.18 * max(0, min(1, progress)) }
}
