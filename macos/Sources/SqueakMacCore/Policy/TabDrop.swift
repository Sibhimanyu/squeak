import Foundation

/// Where a dragged tab lands on a strip when it is dropped over another tab: before it on the left half, after it on
/// the right half. One pure decision shared by every strip (centre, side zones), so the insertion line and the drop
/// agree. Nothing here knows about views.
public enum TabDrop {
    public enum Side: Equatable, Sendable { case before, after }

    public struct Landing<ID: Hashable>: Equatable {
        public let anchor: ID
        public let side: Side
        public init(anchor: ID, side: Side) { self.anchor = anchor; self.side = side }
    }

    /// Which half of a tab (`width` wide) the pointer at `x` (from its leading edge) is over. The exact middle is the
    /// right half.
    public static func side(x: Double, width: Double) -> Side {
        width > 0 && x >= width / 2 ? .after : .before
    }

    /// The landing for `dragged` dropped over `target` at `x` in `order` (the strip's tabs left to right), or nil when
    /// the drop changes nothing: onto its own slot, or into the gap it already sits in (just before the tab that
    /// follows it, just after the one that precedes it). A tab from another strip (`dragged` not in `order`, or nil)
    /// always lands. The left half of the first tab is the start of the strip, the right half of the last the end.
    public static func landing<ID: Hashable>(in order: [ID], dragged: ID?, over target: ID, x: Double, width: Double) -> Landing<ID>? {
        if let dragged, dragged == target { return nil }
        let landing = Landing(anchor: target, side: side(x: x, width: width))
        if let dragged, let from = order.firstIndex(of: dragged), let to = order.firstIndex(of: target) {
            if landing.side == .before, from == to - 1 { return nil }
            if landing.side == .after, from == to + 1 { return nil }
        }
        return landing
    }

    /// The tab the dragged one is inserted before once it is taken out of `order`; nil means the end of the strip.
    public static func insertBefore<ID: Hashable>(in order: [ID], dragged: ID?, landing: Landing<ID>) -> ID? {
        let rest = order.filter { $0 != dragged }
        guard let at = rest.firstIndex(of: landing.anchor) else { return nil }
        switch landing.side {
        case .before: return rest[at]
        case .after: return at + 1 < rest.count ? rest[at + 1] : nil
        }
    }

    /// `order` after the drop (the dragged tab removed and put back at the landing).
    public static func applying<ID: Hashable>(_ landing: Landing<ID>, moving dragged: ID, in order: [ID]) -> [ID] {
        var rest = order.filter { $0 != dragged }
        guard let at = rest.firstIndex(of: landing.anchor) else { return order }
        rest.insert(dragged, at: landing.side == .before ? at : at + 1)
        return rest
    }

    /// The landing for moving `tab` one place `delta` (-1 left, +1 right) with the keyboard; nil at either end or when
    /// the tab is not in `order`.
    public static func step<ID: Hashable>(in order: [ID], tab: ID, by delta: Int) -> Landing<ID>? {
        guard delta != 0, let at = order.firstIndex(of: tab) else { return nil }
        let to = at + (delta < 0 ? -1 : 1)
        guard order.indices.contains(to) else { return nil }
        return Landing(anchor: order[to], side: delta < 0 ? .before : .after)
    }
}

/// How far the canvas Fit button's zoom has come: ease-out like every Squeak motion (DESIGN.md section 7), and no
/// travel at all under Reduce Motion. The view samples `frame` each display tick.
public enum CanvasFitMotion {
    public static let duration: Double = 0.2

    public struct Pose: Equatable, Sendable {
        public var magnification: Double
        public var originX: Double
        public var originY: Double
        public init(magnification: Double, originX: Double, originY: Double) {
            self.magnification = magnification; self.originX = originX; self.originY = originY
        }
    }

    /// Ease-out (cubic) progress for `elapsed` seconds in; 1 once done or when `reduceMotion`.
    public static func progress(elapsed: Double, reduceMotion: Bool) -> Double {
        if reduceMotion || duration <= 0 { return 1 }
        let t = min(max(elapsed / duration, 0), 1)
        return 1 - pow(1 - t, 3)
    }

    /// The pose at `progress` between `from` and `to`; exactly `to` at 1.
    public static func frame(from: Pose, to: Pose, progress p: Double) -> Pose {
        if p >= 1 { return to }
        func lerp(_ a: Double, _ b: Double) -> Double { a + (b - a) * p }
        return Pose(magnification: lerp(from.magnification, to.magnification),
                    originX: lerp(from.originX, to.originX), originY: lerp(from.originY, to.originY))
    }
}
