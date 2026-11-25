import Foundation

// The Dashboard <-> Room swipe, after the fingers lift: a velocity-aware spring to the page the strip is heading for, and what
// the top bar's switch shows while the strip moves. Pure: the view steps the spring once per display frame and draws.

/// A spring on the strip's position (0 Dashboard ... 1 Room) from where the fingers left it, at the speed they left it, to the
/// page it settles on. Critically damped by default, so a flick glides in with no bounce and a slow release eases in; the
/// motion continues the fingers' own, never restarts from rest.
public struct SwipeSpring: Sendable, Equatable {
    public static let defaultResponse = 0.30
    public static let defaultDamping = 1.0
    /// Settled when within this much of the target (a share of the width, under a pixel) and slower than `restSpeed`.
    public static let restDistance = 0.0008
    public static let restSpeed = 0.02

    public let from: Double
    public let target: Double
    /// Position units per second, signed (toward the target is the sign of `target - from`).
    public let velocity: Double
    public let response: Double
    public let damping: Double

    public init(from: Double, target: Double, velocity: Double = 0, response: Double = defaultResponse, damping: Double = defaultDamping) {
        self.from = from; self.target = target; self.velocity = velocity
        self.response = max(0.05, response); self.damping = max(0.2, damping)
    }

    private var omega: Double { 2 * Double.pi / response }

    /// The position `t` seconds after release.
    public func position(at t: Double) -> Double { value(at: max(0, t)) }

    private func value(at t: Double) -> Double {
        let d = from - target, w = omega, z = damping
        let decay = exp(-z * w * t)
        let offset: Double
        if z < 1 {
            let wd = w * (1 - z * z).squareRoot()
            offset = decay * (d * cos(wd * t) + (velocity + z * w * d) / wd * sin(wd * t))
        } else if z == 1 {
            offset = decay * (d + (velocity + w * d) * t)
        } else {
            let s = (z * z - 1).squareRoot()
            let r1 = -w * (z - s), r2 = -w * (z + s)
            let c2 = (velocity - r1 * d) / (r2 - r1), c1 = d - c2
            offset = c1 * exp(r1 * t) + c2 * exp(r2 * t)
        }
        return target + offset
    }

    /// The speed `t` seconds after release, position units per second.
    public func speed(at t: Double) -> Double {
        let h = 1.0 / 2000
        return (value(at: t + h) - value(at: t - h)) / (2 * h)
    }

    public func isSettled(at t: Double) -> Bool {
        abs(position(at: t) - target) < Self.restDistance && abs(speed(at: t)) < Self.restSpeed
    }

    /// When the spring is settled (capped, so a display link never runs on).
    public var duration: Double {
        var t = 0.0
        while t < 1.5 { if isSettled(at: t) { return t }; t += 1.0 / 120 }
        return 1.5
    }
}

/// Where a released swipe goes and how fast it is already moving.
public enum SwipeSettle {
    public static func other(than page: PondPage) -> PondPage { page == .dashboard ? .room : .dashboard }

    /// The page a swipe that ended at `position` settles on, from the page it began on: past 30% of the width, or a flick toward
    /// the other page, switches; otherwise it falls back. `velocity` is signed position units per second.
    public static func page(from page: PondPage, position: Double, velocity: Double, width: Double) -> PondPage {
        let dir = PondDrag.home(other(than: page)) - PondDrag.home(page)
        let travelShare = (position - PondDrag.home(page)) * dir
        let toward = velocity * dir * width
        return SwipeCommit.commits(travelShare: travelShare, velocityToward: toward, travel: travelShare * width) ? other(than: page) : page
    }

    /// The spring's starting velocity in position units per second, from the fingers' speed in points per second `toward`
    /// the page it settles on (0 when unknown).
    public static func velocity(pointsPerSecond toward: Double, width: Double, from: Double, to: Double) -> Double {
        guard width > 0, to != from else { return 0 }
        return toward / width * (to > from ? 1 : -1)
    }
}

/// How the two live pages are dressed while the strip moves: the page that is not at rest slides over the other, and a flat
/// scrim gives the depth. Nothing is drawn over a page that is simply showing.
public enum PondStripPlan {
    /// The flat dimming over a page `x` points from home: none at rest, 28% a full width away; exactly 0 within a point of home.
    public static func scrim(x: Double, width: Double) -> Double {
        guard abs(x) >= 1 else { return 0 }
        return 0.28 * min(1, abs(x) / max(1, width))
    }

    /// Which page takes clicks: the one the strip is mostly showing, so a visible page is never dead and an off-screen one
    /// never catches a click. Decided from where the strip is drawn, not from a copy of the page (a stale copy once left the
    /// visible page inert while the switch said the other one).
    public static func takesClicks(page: PondPage, drawn: Double) -> Bool {
        let nearest: PondPage = drawn < 0.5 ? .dashboard : .room
        return page == nearest
    }

    /// Stacking order: the page that is not at rest is drawn on top, in both directions.
    public static func zPosition(of page: PondPage, rest: PondPage) -> Double { page == rest ? 0 : 1 }
}

/// The top bar's Dashboard | Room switch: its selection follows what the centre shows (`PondCentre`), and slides with the strip
/// while a swipe moves it.
public enum PondSwitchIndicator {
    /// Where the selection pill sits, 0 under Dashboard ... 1 under Room; nil when no page is selected (a Duck or an item
    /// covers the pages). A moving strip's position wins, clamped so a rubber band does not carry the pill off its track.
    public static func progress(selection: PondPage?, strip: Double?) -> Double? {
        guard let selection else { return nil }
        guard let strip else { return PondDrag.home(selection) }
        return min(1, max(0, strip))
    }

    /// How much `page`'s label is the selected one, 0...1 (its label darkens as the pill arrives under it).
    public static func weight(of page: PondPage, progress: Double) -> Double {
        max(0, min(1, 1 - abs(progress - PondDrag.home(page))))
    }

    /// The pill's left edge and width at `progress`, between two segments' frames.
    public static func pill(progress: Double, dashboard: (x: Double, width: Double), room: (x: Double, width: Double)) -> (x: Double, width: Double) {
        let p = max(0, min(1, progress))
        return (dashboard.x + (room.x - dashboard.x) * p, dashboard.width + (room.width - dashboard.width) * p)
    }
}
