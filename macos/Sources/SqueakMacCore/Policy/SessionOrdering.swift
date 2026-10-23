import Foundation

public struct OrderedSessions: Equatable, Sendable {
    public var pinned: [HostSession]
    public var active: [HostSession]
    public var recent: [HostSession]

    public var flattened: [HostSession] { pinned + active + recent }
}

public enum SessionOrdering {
    public static let recentFinishWindow: TimeInterval = 24 * 60 * 60

    /// A session is active if it is working or blocked (and not known to be dead),
    /// or it finished within the last 24 hours.
    public static func isActive(_ s: HostSession, now: Date) -> Bool {
        switch s.state {
        case .working, .blocked:
            return s.alive != false
        case .finished:
            guard let t = s.lastActivityAt else { return false }
            return now.timeIntervalSince(t) <= recentFinishWindow
        default:
            return false
        }
    }

    public static func order(_ sessions: [HostSession], pinned: Set<SessionKey> = [], now: Date = Date()) -> OrderedSessions {
        var p: [HostSession] = [], a: [HostSession] = [], r: [HostSession] = []
        for s in sessions {
            if pinned.contains(s.key) { p.append(s) } else if isActive(s, now: now) { a.append(s) } else { r.append(s) }
        }
        return OrderedSessions(pinned: p.sorted(by: before), active: a.sorted(by: before), recent: r.sorted(by: before))
    }

    /// Newest first; unknown times last; ties broken by key so the order is stable.
    static func before(_ x: HostSession, _ y: HostSession) -> Bool {
        switch (x.lastActivityAt, y.lastActivityAt) {
        case let (a?, b?) where a != b: return a > b
        case (nil, .some): return false
        case (.some, nil): return true
        default: return x.key.stringValue < y.key.stringValue
        }
    }
}
