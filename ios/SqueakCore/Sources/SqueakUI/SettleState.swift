import Foundation

/// When a one-tap control that sends something is safe to press: it has been on screen, and the layout around it
/// has held still, for a moment. A chat fills in over its first second (history, queue, steps), and a tap that lands
/// on a row that was moving answers a question nobody meant to answer. Pure, so CI can test the timing.
struct SettleState: Equatable {
    /// How long the layout must hold after the control appears or the chat's rows last changed.
    static let layoutSettle: TimeInterval = 0.5
    /// How long after a scroll stops: a tap that ends a coasting scroll must not press what is under the finger.
    static let scrollSettle: TimeInterval = 0.3

    private(set) var layoutChangedAt: Date
    private(set) var scrollEndedAt: Date?
    private(set) var scrolling = false

    init(appearedAt: Date) { layoutChangedAt = appearedAt }

    /// The rows or the content's size changed.
    mutating func layoutChanged(at now: Date) { layoutChangedAt = max(layoutChangedAt, now) }

    /// A finger is scrolling (or the view is coasting), or it just stopped.
    mutating func scrollChanged(scrolling now: Bool, at date: Date) {
        if scrolling, !now { scrollEndedAt = date }
        scrolling = now
    }

    /// The moment it becomes safe if nothing else changes; nil while a scroll is in progress.
    var settledAt: Date? {
        guard !scrolling else { return nil }
        let layout = layoutChangedAt.addingTimeInterval(Self.layoutSettle)
        guard let scrollEndedAt else { return layout }
        return max(layout, scrollEndedAt.addingTimeInterval(Self.scrollSettle))
    }

    func isSettled(at now: Date) -> Bool {
        guard let settledAt else { return false }
        return now >= settledAt
    }
}

/// What the chat tells the controls inside it: a counter that moves whenever the layout changes, and whether a
/// scroll is under way. Controls outside a chat see the default and settle on appearing alone.
struct ChatSettleSignal: Equatable {
    var epoch = 0
    var scrolling = false
}

/// Folds a burst of timeline updates into one swap: the first update schedules a flush `window` later, the ones
/// after it ride along. Urgent updates (the person's own send) flush at once.
struct UpdateCoalescer: Equatable {
    static let window: TimeInterval = 0.15

    enum Decision: Equatable {
        case now
        /// A flush is already due at this time.
        case pending(Date)
        /// Schedule a flush at this time.
        case schedule(Date)
    }

    private(set) var deadline: Date?
    var window: TimeInterval = Self.window

    mutating func offer(at now: Date, urgent: Bool = false, delay: TimeInterval? = nil) -> Decision {
        if urgent { deadline = nil; return .now }
        if let deadline { return .pending(deadline) }
        let due = now.addingTimeInterval(delay ?? window)
        deadline = due
        return .schedule(due)
    }

    mutating func flushed() { deadline = nil }
}
