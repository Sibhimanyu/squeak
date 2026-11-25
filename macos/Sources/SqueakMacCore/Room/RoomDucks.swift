import Foundation

// The pond's ducks as members (draft A): the header's avatars and the right panel's roster. Pure; the view only draws.

public enum RoomDuckPresence: Sendable, Equatable {
    /// A tide glyph.
    case working
    /// A warning triangle.
    case waiting
    case idle
    /// Greyed.
    case off
}

public struct RoomDuck: Sendable, Equatable, Identifiable {
    public var id: String { sessionId }
    public var sessionId: String
    public var name: String
    public var agent: String?
    public var agentLabel: String?
    /// The person's one-line role, else the chat's title when it is not the duck's name.
    public var roleLine: String?
    public var presence: RoomDuckPresence
    /// "Working \u{00B7} 3 of 5", "Waiting on you", "Idle \u{00B7} 2h ago", "Off duty".
    public var presenceLine: String
    public var onDuty: Bool { presence != .off }
    public var role: String?
}

public enum RoomDucks {
    public static func agentLabel(_ agent: String?) -> String? {
        guard let a = agent?.lowercased(), !a.isEmpty else { return nil }
        if a.contains("claude") { return "Claude" }
        if a.contains("codex") { return "Codex" }
        return agent.map { $0.prefix(1).uppercased() + $0.dropFirst() }
    }

    /// Newest activity first, off duty last; ties by name, so the roster only moves when something real happens.
    public static func roster(_ threads: [RoomThread], now: Date = Date()) -> [RoomDuck] {
        func key(_ t: RoomThread) -> Int64 { t.lastActiveAt ?? t.turnStartedAt ?? t.lastAt ?? 0 }
        return threads.sorted { a, b in
            if a.onDuty != b.onDuty { return a.onDuty }
            if key(a) != key(b) { return key(a) > key(b) }
            return (a.duckName, a.sessionId) < (b.duckName, b.sessionId)
        }.map { duck($0, now: now) }
    }

    /// The header's avatars: only ducks on duty (the host's `duty`); none when every duck is closed.
    public static func headerDucks(_ threads: [RoomThread], now: Date = Date()) -> [RoomDuck] {
        roster(threads.filter(\.onDuty), now: now)
    }

    public static func duck(_ t: RoomThread, now: Date = Date()) -> RoomDuck {
        let presence: RoomDuckPresence = !t.onDuty ? .off : (t.state == .working ? .working : (t.state == .waiting ? .waiting : .idle))
        let title = t.title.trimmingCharacters(in: .whitespaces)
        return RoomDuck(
            sessionId: t.sessionId, name: t.duckName, agent: t.agent, agentLabel: agentLabel(t.agent),
            roleLine: t.role ?? (title.isEmpty || title == t.duckName ? nil : title), presence: presence,
            presenceLine: presenceLine(t, presence: presence, now: now), role: t.role)
    }

    static func presenceLine(_ t: RoomThread, presence: RoomDuckPresence, now: Date) -> String {
        switch presence {
        case .off: return RoomRoster.offDutyAgo(t.lastActiveAt, now: now)
        case .waiting: return "Waiting on you"
        case .working:
            if let p = t.progress { return "Working \u{00B7} \(p.current) of \(p.total)" }
            return "Working"
        case .idle:
            let lead = t.state == .error ? "Hit an error" : "Idle"
            guard let at = t.lastActiveAt ?? t.lastAt, at > 0 else { return lead }
            return "\(lead) \u{00B7} \(ago(at, now: now))"
        }
    }

    /// "just now", "5m ago", "2h ago", "yesterday", "3d ago".
    public static func ago(_ at: Int64, now: Date) -> String {
        let s = max(0, Int(now.timeIntervalSince1970 - Double(at) / 1000))
        if s < 45 { return "just now" }
        if s < 3600 { return "\(max(1, s / 60))m ago" }
        if s < 86_400 { return "\(s / 3600)h ago" }
        if s < 2 * 86_400 { return "yesterday" }
        return "\(s / 86_400)d ago"
    }

    /// "2 people \u{00B7} 5 ducks on duty": the header counts only ducks with a live chat; off duty Ducks are not counted.
    public static func subtitle(people: Int, ducks: Int) -> String {
        let p = people == 1 ? "1 person" : "\(people) people"
        let d = ducks == 0 ? "no ducks on duty" : (ducks == 1 ? "1 duck on duty" : "\(ducks) ducks on duty")
        return "\(p) \u{00B7} \(d)"
    }

    /// The duck's name as the host takes it (1 to 32 characters): nil when it cannot be sent.
    public static func cleanName(_ s: String) -> String? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return (1...32).contains(t.count) ? t : nil
    }

    /// The role as the host takes it (0 to 80 characters); empty clears it. Nil when too long.
    public static func cleanRole(_ s: String) -> RoomDuckField? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return .clear }
        return t.count <= 80 ? .set(t) : nil
    }
}
