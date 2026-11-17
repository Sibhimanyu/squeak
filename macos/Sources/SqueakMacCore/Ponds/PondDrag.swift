import Foundation

// The Dashboard <-> Room swipe as a gesture the pages follow (DESIGN.md §7): pure, so the view only draws what comes back.
// The pages are one strip: `position` 0 is the Dashboard, 1 the Room, and the strip follows the fingers one to one, like
// Safari's back swipe. Past either end it rubber-bands. The gesture commits by distance or by a flick.

/// One finger sample: cumulative horizontal travel `x` (points) at time `t` (seconds).
public struct SwipeSample: Sendable, Equatable {
    public var t: Double
    public var x: Double
    public init(t: Double, x: Double) { self.t = t; self.x = x }
}

/// Velocity from the last ~80 ms of samples.
public enum SwipeVelocity {
    public static let window = 0.08

    /// Signed points per second (fingers right = positive) over the samples in the last `window` before `now` (the newest
    /// sample's time when nil). 0 when fewer than two samples fall in it, when they span under 8 ms, or when the fingers
    /// had rested for longer than the window before `now`.
    public static func estimate(_ samples: [SwipeSample], now: Double? = nil) -> Double {
        guard let last = samples.last else { return 0 }
        let at = now ?? last.t
        let recent = samples.filter { $0.t >= at - window }
        guard let first = recent.first, let end = recent.last, recent.count >= 2 else { return 0 }
        let dt = end.t - first.t
        guard dt >= 0.008 else { return 0 }
        return (end.x - first.x) / dt
    }
}

/// When a gesture that ends commits: past 30% of the width, or a flick.
public enum SwipeCommit {
    public static let distanceShare = 0.30
    /// Points per second, in the direction of the other page.
    public static let flickVelocity = 600.0
    /// A flick still has to have gone this far (points) so a jitter does not switch pages.
    public static let flickMinTravel = 24.0

    /// `travelShare` is how far toward the other page the strip sits (share of the width); `velocityToward` the fingers'
    /// speed toward it in points per second (negative = away); `travel` their travel in points.
    public static func commits(travelShare: Double, velocityToward: Double, travel: Double) -> Bool {
        if travelShare > distanceShare { return true }
        return velocityToward > flickVelocity && abs(travel) >= flickMinTravel && travelShare > 0
    }
}

/// The easing every finish uses: cubic-bezier(0.22, 1, 0.36, 1), a strong ease-out. No springs (§7).
public enum SwipeCurve {
    public static let x1 = 0.22, y1 = 1.0, x2 = 0.36, y2 = 1.0

    /// Eased progress 0...1 at linear time `t` 0...1.
    public static func value(_ t: Double) -> Double {
        let t = max(0, min(1, t))
        if t == 0 || t == 1 { return t }
        // Solve x(s) = t by bisection, then read y(s).
        var lo = 0.0, hi = 1.0
        for _ in 0..<40 {
            let mid = (lo + hi) / 2
            if bezier(mid, x1, x2) < t { lo = mid } else { hi = mid }
        }
        return bezier((lo + hi) / 2, y1, y2)
    }

    private static func bezier(_ s: Double, _ a: Double, _ b: Double) -> Double {
        let u = 1 - s
        return 3 * u * u * s * a + 3 * u * s * s * b + s * s * s
    }
}

/// How long a finish or a settle takes.
public enum SwipeFinish {
    public static let commitRange = 0.18...0.35
    public static let settleRange = 0.14...0.26

    /// A finish to the other page from `remainingShare` of the width away (0...1), at `velocity` points per second toward
    /// it (0 when unknown): longer for more distance, no longer than the fingers' own speed would take.
    public static func commitDuration(remainingShare: Double, width: Double, velocity: Double) -> Double {
        scaled(commitRange, remainingShare: remainingShare, width: width, velocity: velocity)
    }

    /// Back to rest, shorter than a finish.
    public static func settleDuration(remainingShare: Double, width: Double, velocity: Double) -> Double {
        scaled(settleRange, remainingShare: remainingShare, width: width, velocity: velocity)
    }

    private static func scaled(_ range: ClosedRange<Double>, remainingShare: Double, width: Double, velocity: Double) -> Double {
        let share = max(0, min(1, remainingShare))
        var d = range.lowerBound + (range.upperBound - range.lowerBound) * share
        if velocity > 1, width > 0 { d = min(d, share * width / velocity * 1.2) }
        return max(range.lowerBound, min(range.upperBound, d))
    }
}

/// The ring on the hint button while dragging.
public enum SwipeRing {
    /// The stroke's trim (0...1): full exactly when the gesture would commit.
    public static func trim(progress: Double) -> Double { max(0, min(1, progress)) }
    /// The chevron has turned to point back once the gesture would commit: the arrow that waits on the page landed on.
    public static func flipped(progress: Double) -> Bool { progress >= 1 }
}

/// Fires once per gesture, the moment its progress first reaches the commit point (the light haptic).
public struct SwipeHapticLatch: Sendable, Equatable {
    private var fired = false
    public init() {}
    public mutating func crosses(progress: Double) -> Bool {
        guard !fired, progress >= 1 else { return false }
        fired = true
        return true
    }
    public mutating func reset() { fired = false }
}

/// Follows one two-finger gesture. `feed` returns what the view should do: follow the fingers, complete the switch, or
/// settle back. Fingers right = the strip moves right (toward the Dashboard).
public struct PondDrag: Sendable, Equatable {
    public enum Update: Sendable, Equatable {
        /// Draw the strip at this position (0 Dashboard ... 1 Room; a little outside while rubber-banding).
        case track(Double)
        /// The gesture ended past the point: finish to this page from `from`, the fingers going `velocity` points/s toward it.
        case commit(PondPage, from: Double, velocity: Double)
        /// The gesture ended short, or turned into a scroll: ease back to rest from `from`.
        case settle(from: Double, velocity: Double)
    }

    /// Past an end the strip gives this share of the width at most, and tracks at 55% of the fingers near the end.
    public static let rubberShare = 0.12

    private var x = 0.0
    private var y = 0.0
    private var origin = 0.0
    private var position = 0.0
    private var samples: [SwipeSample] = []
    private var active = false
    private var spent = false
    private var moved = false

    public init() {}

    /// Where the strip rests for `page`.
    public static func home(_ page: PondPage) -> Double { page == .room ? 1 : 0 }
    private static func direction(from page: PondPage) -> Double { page == .dashboard ? 1 : -1 }

    /// Rubber band for `over` (share of the width past an end): the strip gives less and less.
    public static func rubber(_ over: Double) -> Double {
        guard over > 0 else { return 0 }
        return rubberShare * (1 - 1 / (over * 0.55 / rubberShare + 1))
    }

    /// The strip's position when the fingers have travelled `delta` points (right = positive) from `origin`.
    public static func position(origin: Double, delta: Double, width: Double) -> Double {
        guard width > 0 else { return origin }
        let raw = origin - delta / width
        if raw < 0 { return -rubber(-raw) }
        if raw > 1 { return 1 + rubber(raw - 1) }
        return raw
    }

    /// How far the strip sits toward the page that is not `page`, as a share of the width (0 at rest and away from it).
    public static func travel(position: Double, page: PondPage) -> Double {
        max(0, min(1, (position - home(page)) * direction(from: page)))
    }

    /// Travel as a share of what commits, 0...1: the ring's progress.
    public static func progress(position: Double, page: PondPage) -> Double {
        min(1, travel(position: position, page: page) / SwipeCommit.distanceShare)
    }

    /// Where a page's left edge sits at `position`, in points: the Dashboard at 0 and the Room a width to its right.
    public static func x(of page: PondPage, position: Double, width: Double) -> Double {
        (home(page) - position) * width
    }

    public mutating func reset() {
        x = 0; y = 0; active = false; spent = false; moved = false; samples = []
        origin = 0; position = 0
    }

    /// One scroll event. `dx`/`dy` follow the fingers (negative dx = fingers moved left). Inertia is ignored. `time` is the
    /// event's time in seconds (for the flick); `origin` is where the strip was when the gesture began (a finish still in
    /// flight), the current page's rest when nil.
    public mutating func feed(
        dx: Double, dy: Double, phase: PondSwipe.Phase, momentum: Bool, current: PondPage, width: Double,
        time: Double = 0, origin start: Double? = nil
    ) -> Update? {
        if momentum { return nil }
        switch phase {
        case .none: return nil
        case .began: reset(); active = true; origin = start ?? Self.home(current); position = origin
        case .cancelled:
            let was = moved, from = position; reset()
            return was ? .settle(from: from, velocity: 0) : nil
        case .ended:
            let result = ending(current: current, width: width, time: time)
            reset()
            return result
        case .changed:
            if !active { reset(); active = true; origin = start ?? Self.home(current); position = origin }
        }
        guard active, !spent else { return nil }
        x += dx; y += dy
        samples.append(SwipeSample(t: time, x: x))
        if samples.count > 24 { samples.removeFirst(samples.count - 24) }
        if abs(y) > abs(x) * PondSwipe.dominance, abs(y) > 12 {
            spent = true
            let was = moved, from = position; moved = false
            return was ? .settle(from: from, velocity: 0) : nil
        }
        guard abs(x) >= 4 else { return nil }
        moved = true
        position = Self.position(origin: origin, delta: x, width: width)
        return .track(position)
    }

    private func ending(current: PondPage, width: Double, time: Double) -> Update? {
        guard active, !spent, moved else { return nil }
        let v = SwipeVelocity.estimate(samples, now: time)
        let dir = Self.direction(from: current)
        // Fingers right = toward the Dashboard (position down): toward the other page is -v for the Dashboard.
        let towardOther = current == .dashboard ? -v : v
        let share = (position - Self.home(current)) * dir
        let horizontal = abs(x) >= abs(y) * PondSwipe.dominance
        if horizontal, SwipeCommit.commits(travelShare: share, velocityToward: towardOther, travel: x) {
            return .commit(current == .dashboard ? .room : .dashboard, from: position, velocity: max(0, towardOther))
        }
        // A strip that was grabbed mid-finish and let go near the page it was heading to still lands there.
        return .settle(from: position, velocity: max(0, -towardOther))
    }
}

/// The edge hint: a button with the other page's name, a ripple while idle, and the first-visit peek. Counts live in
/// UserDefaults; this decides.
public struct PondSwipeHint: Sendable, Equatable {
    /// The ripple (and the peek) teach on the first few visits only.
    public static let nudgeVisits = 3
    public static let wordSwipes = 3
    /// Seconds between ripples while idle.
    public static let rippleInterval = 6.0
    /// Points the chevron drifts toward the swipe in step with a ripple.
    public static let driftDistance = 4.0
    /// First visit only: the page slides this far toward the other one, 1.2 s after the pond opens, and eases back.
    public static let peekDistance = 28.0
    public static let peekDelay = 1.2

    /// Visits to a pond view so far, this one included.
    public var visits: Int
    /// Successful swipes in total.
    public var swipes: Int

    public init(visits: Int = 0, swipes: Int = 0) { self.visits = visits; self.swipes = swipes }

    /// Whether a ripple plays now: the first three visits, before the third swipe, the window key, never under Reduce Motion.
    public func ripples(reduceMotion: Bool, windowIsKey: Bool) -> Bool {
        !reduceMotion && windowIsKey && visits <= Self.nudgeVisits && swipes < Self.wordSwipes
    }
    /// Seconds to wait before the next ripple (the first comes after the same interval).
    public var rippleDelay: Double { Self.rippleInterval }
    /// The peek: the first visit only, before any swipe, never under Reduce Motion.
    public func peeks(reduceMotion: Bool) -> Bool { !reduceMotion && visits == 1 && swipes == 0 }
    /// The word goes once the person has swiped a few times; the quieter button stays.
    public var showsWord: Bool { swipes < Self.wordSwipes }
    /// Idle opacity of the button: inviting while it still teaches, quieter after.
    public var restingOpacity: Double { swipes < Self.wordSwipes ? 0.85 : 0.45 }
    /// The peek as a position offset: toward the other page from `page`, `peekDistance` points of a `width`-wide view.
    public static func peekPosition(page: PondPage, width: Double) -> Double {
        guard width > 0 else { return PondDrag.home(page) }
        return PondDrag.home(page) + (page == .dashboard ? 1 : -1) * peekDistance / width
    }
}
