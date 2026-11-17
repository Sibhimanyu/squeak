import Foundation

// The pond's navigation flow: a pond opens on its Dashboard, the Dashboard and the Room swap with a two-finger swipe or
// the switch, anything clicked in either opens as a tab, and closing that tab comes back to where it was opened from.
// Pure: the views only feed events in and draw what these return.

/// The pond's two pages. The Dashboard is the landing page.
public enum PondPage: String, CaseIterable, Sendable, Equatable {
    case dashboard, room
    public var title: String { self == .room ? "Room" : "Dashboard" }
}

/// Stashed 2026-11-17, owner: bring back later. While `enabled` is false the right-hand inspector zone (the pond room's
/// inspector and the thread's Who / Controls / Approvals / Model) is not shown anywhere and has no toggle; all of its code
/// still builds and its tests still run.
public enum InspectorStash {
    public static let enabled = false
}

/// Decides whether a stream of trackpad scroll events is a two-finger horizontal swipe between the Dashboard and the Room.
/// The view feeds each scroll event: `dx`/`dy` are in the direction the fingers moved (negative dx = fingers moved left,
/// whatever the system's scroll direction setting), `phase` is the event's own phase and `momentum` is true for the
/// inertia events a swipe leaves behind. One switch per gesture: after it fires, the rest of the gesture (and its momentum)
/// is ignored until the next one begins.
public struct PondSwipe: Sendable, Equatable {
    public enum Phase: Sendable, Equatable { case began, changed, ended, cancelled, none }

    /// Points the fingers must travel sideways before it counts.
    public static let threshold = 80.0
    /// How much more sideways than vertical the travel must be, so a diagonal scroll is not a swipe.
    public static let dominance = 2.0

    private var x = 0.0
    private var y = 0.0
    private var active = false
    private var spent = false

    public init() {}

    /// The page to show now, or nil when this event decides nothing (or the target is the page already shown).
    public mutating func feed(dx: Double, dy: Double, phase: Phase, momentum: Bool, current: PondPage) -> PondPage? {
        // Inertia is never a new swipe; a plain wheel (no phase) is never one either.
        if momentum { return nil }
        switch phase {
        case .none: return nil
        case .began:
            x = 0; y = 0; active = true; spent = false
        case .ended, .cancelled:
            active = false; x = 0; y = 0; spent = false
            return nil
        case .changed:
            // A gesture that began before this view was under the cursor is picked up where it is.
            if !active { active = true; x = 0; y = 0; spent = false }
        }
        guard active, !spent else { return nil }
        x += dx; y += dy
        // Vertical travel ahead of sideways travel makes it a scroll for the rest of the gesture.
        if abs(y) > abs(x) * Self.dominance, abs(y) > 12 { spent = true; return nil }
        guard abs(x) >= Self.threshold, abs(x) >= abs(y) * Self.dominance else { return nil }
        spent = true
        let target: PondPage = x < 0 ? .room : .dashboard
        return target == current ? nil : target
    }

    /// Forgets the gesture in flight (the view left the window).
    public mutating func reset() { x = 0; y = 0; active = false; spent = false }
}

/// What a click in the pond opens as a tab.
public enum PondOpenTarget: Sendable, Equatable {
    /// A duck's own tab.
    case duck(String)
    /// A duck's ducklings: its tab, then the duckling tabs whose titles are `labels` (all of them when empty).
    case ducklings(duck: String, labels: [String])

    /// The duck the target belongs to.
    public var duck: String {
        switch self { case .duck(let d): d; case .ducklings(let d, _): d }
    }
}

/// Which tab each thing clicked in the room opens. Nil means the click does nothing.
public enum PondClick {
    /// A duck's avatar or name, its reply bubble, the files chip, its working line or a roster row: the duck. A person's
    /// avatar, name or message: the duck that message went to.
    public static func target(author: RoomMessageAuthor, goesTo: String?) -> PondOpenTarget? {
        switch author.kind {
        case .duck: author.sessionId.map(PondOpenTarget.duck)
        case .me, .person: goesTo.map(PondOpenTarget.duck)
        }
    }

    public static func target(message: RoomMessage) -> PondOpenTarget? { target(author: message.author, goesTo: message.goesTo) }

    /// A part of a duck's message. The ask card and the offer have buttons of their own, so they open nothing.
    public static func target(part: RoomPart, in message: RoomMessage) -> PondOpenTarget? {
        switch part {
        case .text: target(message: message)
        case .chip(let sessionId, _): .duck(sessionId)
        case .ducklings(let set): message.author.sessionId.map { .ducklings(duck: $0, labels: set.items.map(\.label)) }
        case .ask, .offer: nil
        }
    }

    /// One duckling in the disclosure: its own tab.
    public static func target(duckling: RoomDuckling, of duck: String) -> PondOpenTarget { .ducklings(duck: duck, labels: [duckling.label]) }

    /// Squeak's quiet line: a handoff opens the duck it went to.
    public static func target(line: RoomSystemLine) -> PondOpenTarget? { line.opens.map(PondOpenTarget.duck) }

    /// A job's handed duck.
    public static func target(job: RoomJob) -> PondOpenTarget? { job.handedTo.map { .duck($0.sessionId) } }
}

/// Where a tab opened from a pond came from, so closing the last of them comes back. One pond at a time: opening from
/// another pond, or opening a pond by itself, starts over.
public struct PondOriginStack: Sendable, Equatable {
    public struct Origin: Sendable, Equatable { public var pond: String; public var page: PondPage }

    public private(set) var origin: Origin?
    /// The tabs opened from `origin`, by their ids.
    public private(set) var tabs: [String] = []

    public init() {}

    /// A tab was opened from `page` of `pond`.
    public mutating func opened(tab: String, pond: String, page: PondPage) {
        if let o = origin, o.pond != pond { tabs = [] }
        origin = Origin(pond: pond, page: page)
        if !tabs.contains(tab) { tabs.append(tab) }
    }

    /// A tab was closed: where to go back to when it was the last one opened from the pond, else nil. A tab not opened from
    /// the pond changes nothing.
    public mutating func closed(tab: String) -> Origin? {
        guard let o = origin, let i = tabs.firstIndex(of: tab) else { return nil }
        tabs.remove(at: i)
        guard tabs.isEmpty else { return nil }
        origin = nil
        return o
    }

    /// A pond opened on its own (the sidebar, the pond picker): nothing is waiting to come back to.
    public mutating func clear() { origin = nil; tabs = [] }

    /// A pond was opened; a different one forgets the old.
    public mutating func pondOpened(_ pond: String) {
        if let o = origin, o.pond != pond { clear() }
    }

    public func has(tab: String) -> Bool { tabs.contains(tab) }
}
