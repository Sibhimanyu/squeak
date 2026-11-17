import Foundation

// The room inspector's Ducks section (DESIGN.md §8.10): the pond's ducks as host identities (`GET /native/projects/<id>/ducks`),
// Available by default with a search over all of them, with presence and place text, the New duck form's checks and the action -> request mapping.
// Pure; the view only draws.

/// A duck as the host lists it (`Duck` in docs/ponds.md, "Ducks"). Decoded leniently.
public struct PondDuck: Sendable, Equatable, Decodable, Identifiable {
    public var id: String
    public var name: String
    public var role: String?
    public var colourSeed: String
    public var duty: RoomDuty
    public var currentSessionId: String?
    public var place: RoomPlace?
    public var state: RoomThreadState
    public var lastActiveAt: Int64?
    public var createdAt: Int64?

    public init(
        id: String, name: String, role: String? = nil, colourSeed: String? = nil, duty: RoomDuty = .on, currentSessionId: String? = nil,
        place: RoomPlace? = nil, state: RoomThreadState = .idle, lastActiveAt: Int64? = nil, createdAt: Int64? = nil
    ) {
        self.id = id; self.name = name; self.role = role; self.colourSeed = colourSeed ?? id; self.duty = duty
        self.currentSessionId = currentSessionId; self.place = place; self.state = state; self.lastActiveAt = lastActiveAt; self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey { case id, name, role, colourSeed, duty, currentSessionId, place, state, lastActiveAt, createdAt }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decode(String.self, forKey: .name)).flatMap { $0.isEmpty ? nil : $0 } ?? "Duck"
        role = (try? c.decode(String.self, forKey: .role)).flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
        colourSeed = (try? c.decode(String.self, forKey: .colourSeed)).flatMap { $0.isEmpty ? nil : $0 } ?? id
        duty = (try? c.decode(String.self, forKey: .duty)).flatMap(RoomDuty.init(rawValue:)) ?? .on
        currentSessionId = (try? c.decode(String.self, forKey: .currentSessionId)).flatMap { $0.isEmpty ? nil : $0 }
        place = try? c.decode(RoomPlace.self, forKey: .place)
        state = (try? c.decode(String.self, forKey: .state)).flatMap(RoomThreadState.init(rawValue:)) ?? .idle
        lastActiveAt = try? c.decode(Int64.self, forKey: .lastActiveAt)
        createdAt = try? c.decode(Int64.self, forKey: .createdAt)
    }

    /// An older host has no duck route: the room page's threads stand in (one per duck, or per chat).
    public init(thread t: RoomThread) {
        self.init(
            id: t.duckId ?? t.sessionId, name: t.duckName, role: t.role, colourSeed: t.colourSeed ?? t.sessionId, duty: t.duty,
            currentSessionId: t.sessionId.isEmpty ? nil : t.sessionId, place: t.place, state: t.state,
            lastActiveAt: t.lastActiveAt ?? t.turnStartedAt ?? t.lastAt)
    }
}

/// One roster row, ready to draw.
public struct RosterDuck: Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var colourSeed: String
    public var agent: String?
    public var agentLabel: String?
    public var role: String?
    /// "on <branch>", nil without a place.
    public var placeChip: String?
    public var presence: RoomDuckPresence
    public var presenceLine: String
    /// The duck's current chat: nil until it has had a job.
    public var sessionId: String?
    public var onDuty: Bool { presence != .off }
    public var hasJob: Bool { sessionId != nil }
}

public struct DuckRoster: Sendable, Equatable {
    public var onDuty: [RosterDuck]
    public var offDuty: [RosterDuck]
    public var count: Int { onDuty.count + offDuty.count }
    /// The default list: Available ducks only.
    public var available: [RosterDuck] { onDuty }
}

public enum RoomRoster {
    public static let noJobLine = "No job yet \u{2014} say something in the room or Give it a job"

    /// "on feat/login"; nil when the duck has no place or the place names no branch.
    public static func placeChip(_ place: RoomPlace?) -> String? {
        guard let b = place?.branch?.trimmingCharacters(in: .whitespaces), !b.isEmpty else { return nil }
        return "on \(b)"
    }

    /// On-duty ducks newest activity first, then off-duty ducks the same way; ties by name then id, so rows move only for real
    /// activity. `threads` supplies what the duck route does not carry (agent, progress), matched by the duck's current session.
    public static func roster(_ ducks: [PondDuck], threads: [RoomThread] = [], now: Date = Date()) -> DuckRoster {
        func key(_ d: PondDuck) -> Int64 { d.lastActiveAt ?? d.createdAt ?? 0 }
        let sorted = ducks.sorted { a, b in
            if key(a) != key(b) { return key(a) > key(b) }
            return (a.name.lowercased(), a.id) < (b.name.lowercased(), b.id)
        }
        let rows = sorted.map { row($0, thread: $0.currentSessionId.flatMap { s in threads.first { $0.sessionId == s } }, now: now) }
        return DuckRoster(onDuty: rows.filter(\.onDuty), offDuty: rows.filter { !$0.onDuty })
    }

    public static func row(_ d: PondDuck, thread: RoomThread? = nil, now: Date = Date()) -> RosterDuck {
        let presence: RoomDuckPresence = d.duty == .off ? .off : (d.state == .working ? .working : (d.state == .waiting ? .waiting : .idle))
        return RosterDuck(
            id: d.id, name: d.name, colourSeed: d.colourSeed, agent: thread?.agent, agentLabel: RoomDucks.agentLabel(thread?.agent), role: d.role,
            placeChip: placeChip(d.place), presence: presence, presenceLine: presenceLine(d, thread: thread, presence: presence, now: now),
            sessionId: d.currentSessionId)
    }

    /// "Working \u{00B7} 3 of 5", "Waiting on you", "Idle \u{00B7} 2h ago", "Off duty", "Ready for a job" (no session yet).
    public static func presenceLine(_ d: PondDuck, thread: RoomThread?, presence: RoomDuckPresence, now: Date) -> String {
        switch presence {
        case .off: return "Off duty"
        case .waiting: return "Waiting on you"
        case .working:
            if let p = thread?.progress { return "Working \u{00B7} \(p.current) of \(p.total)" }
            return "Working"
        case .idle:
            if d.currentSessionId == nil { return "Ready for a job" }
            let lead = d.state == .error ? "Hit an error" : "Idle"
            guard let at = d.lastActiveAt, at > 0 else { return lead }
            return "\(lead) \u{00B7} \(RoomDucks.ago(at, now: now))"
        }
    }

    /// What the Ducks section lists. No query: the Available ducks only (newest activity first). A query searches every duck the
    /// host returned, Available and Off duty, by name or role (case and accent insensitive, every word must match); Available
    /// ones come first, Off duty ones follow greyed (`onDuty == false`) so the row offers Bring back.
    public static func visible(_ ducks: [PondDuck], threads: [RoomThread] = [], query: String, now: Date = Date()) -> [RosterDuck] {
        let r = roster(ducks, threads: threads, now: now)
        let words = query.split(whereSeparator: \.isWhitespace).map(String.init)
        if words.isEmpty { return r.available }
        func hit(_ d: RosterDuck) -> Bool {
            let hay = d.name + " " + (d.role ?? "")
            return words.allSatisfy { hay.range(of: $0, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
        }
        return (r.onDuty + r.offDuty).filter(hit)
    }

    /// "No duck called \u{201C}x\u{201D}", for a search that finds nothing.
    public static func noMatchLine(_ query: String) -> String {
        "No duck called \u{201C}\(query.trimmingCharacters(in: .whitespacesAndNewlines))\u{201D}"
    }
    public static let searchPrompt = "Find a duck"
    public static let bringBackTitle = "Bring back"
    /// The default list with nothing Available while some ducks are off duty.
    public static let noneAvailableLine = "No ducks available. Search to bring one back."

    /// The heading's count and label: "Ducks \u{00B7} 5" (Available ducks).
    public static func header(_ n: Int) -> String { "Ducks \u{00B7} \(n)" }
    public static func offDutyLabel(_ n: Int) -> String { "Off duty \u{00B7} \(n)" }

    /// A thread's duck (or the duck route's, by id) replaced or added: optimistic updates reconcile by duck id.
    public static func upserting(_ d: PondDuck, into list: [PondDuck]) -> [PondDuck] {
        var l = list
        if let i = l.firstIndex(where: { $0.id == d.id }) { l[i] = d } else { l.append(d) }
        return l
    }

    /// What a click on a duck does: open its tab, or nothing (with the line to show) while it has no job.
    public enum Click: Sendable, Equatable { case open(sessionId: String), noJob(String) }
    public static func click(_ d: RosterDuck) -> Click { d.sessionId.map { .open(sessionId: $0) } ?? .noJob(noJobLine) }

    /// "@Name text" as the room's composer would post it, for the Give it a job field. Nil for an empty job.
    public static func jobMessage(duckName: String, text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : "@\(duckName) \(t)"
    }
}

/// The New duck form: name 1 to 32, role optional up to 80. Sends nothing the host would refuse.
public enum NewDuckForm {
    public struct Valid: Sendable, Equatable { public var name: String; public var role: String? }
    public enum Problem: String, Error, Sendable, Equatable {
        case nameMissing = "Give the duck a name."
        case nameTooLong = "A name is 32 characters or fewer."
        case roleTooLong = "A role is 80 characters or fewer."
    }

    public static func validate(name: String, role: String) -> Result<Valid, Problem> {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let r = role.trimmingCharacters(in: .whitespacesAndNewlines)
        if n.isEmpty { return .failure(.nameMissing) }
        if n.count > 32 { return .failure(.nameTooLong) }
        if r.count > 80 { return .failure(.roleTooLong) }
        return .success(Valid(name: n, role: r.isEmpty ? nil : r))
    }
}

/// An action in the roster and the host request it makes.
public enum DuckAction: Sendable, Equatable {
    case create(project: String, name: String, role: String?)
    case rename(duck: String, name: String)
    case setRole(duck: String, role: String?)
    case duty(duck: String, on: Bool)

    public struct Request: Sendable, Equatable {
        public var method: String
        public var path: String
        public var body: NativeJSON?
    }

    public static func list(project: String) -> Request {
        Request(method: "GET", path: "/native/projects/\(NativeHostClient.id(project))/ducks", body: nil)
    }

    public var request: Request {
        switch self {
        case .create(let project, let name, let role):
            var o: [String: NativeJSON] = ["name": .string(name)]
            if let role, !role.isEmpty { o["role"] = .string(role) }
            return Request(method: "POST", path: "/native/projects/\(NativeHostClient.id(project))/ducks", body: .object(o))
        case .rename(let duck, let name):
            return Request(method: "PATCH", path: "/native/ducks/\(NativeHostClient.id(duck))", body: .object(["name": .string(name)]))
        case .setRole(let duck, let role):
            return Request(method: "PATCH", path: "/native/ducks/\(NativeHostClient.id(duck))", body: .object(["role": role.map { .string($0) } ?? .null]))
        case .duty(let duck, let on):
            return Request(method: "POST", path: "/native/ducks/\(NativeHostClient.id(duck))/duty", body: .object(["on": .bool(on)]))
        }
    }
}

/// The duck routes (an absent route answers nil/false so the caller can fall back to the room page's threads).
public struct DuckClient: Sendable {
    let host: NativeHostClient
    public init(host: NativeHostClient) { self.host = host }

    public func list(project: String) async throws -> [PondDuck]? {
        struct R: Decodable { var ducks: [LossyDuck] }
        let r = DuckAction.list(project: project)
        do {
            let data = try await host.call(r.method, r.path, timeout: 10)
            do { return try JSONDecoder().decode(R.self, from: data).ducks.compactMap(\.duck) } catch { throw NativeHostError.badResponse }
        } catch where PondsClient.isAbsent(error) { return nil }
    }

    /// Runs a create / rename / role / duty request; answers the duck as the host now has it.
    public func perform(_ action: DuckAction) async throws -> PondDuck {
        struct R: Decodable { var duck: PondDuck }
        let r = action.request
        let data = try await host.call(r.method, r.path, body: r.body, timeout: 15, maybeSent: r.method == "POST")
        do { return try JSONDecoder().decode(R.self, from: data).duck } catch { throw NativeHostError.badResponse }
    }

    /// One bad duck does not hide the rest.
    private struct LossyDuck: Decodable {
        var duck: PondDuck?
        init(from decoder: Decoder) throws { duck = try? PondDuck(from: decoder) }
    }
}

/// The pond inspector's sections (DESIGN.md §1: needs-you outranks everything, quiet until it matters). Dashboard and Room
/// show the same column in the same order, so a section keeps its identity across a swipe and nothing needs to fade.
public enum PondInspectorSection: String, Sendable, Equatable, CaseIterable, Identifiable {
    case needsYou, ducks, people
    public var id: String { rawValue }
}

/// A duck that waits on the person: one Needs you row.
public struct InspectorNeedsYouRow: Sendable, Equatable, Identifiable {
    public var id: String { sessionId }
    public var sessionId: String
    public var name: String
    public var colourSeed: String
    public var agent: String?
    /// "asks: <first line of the question>" or "wants approval".
    public var text: String
}

public enum PondInspectorSections {
    /// Top to bottom: Needs you (only while a duck waits), Ducks (while there are some, or one can be added), People.
    public static func sections(needsYou: Int, ducks: Int, canAddDuck: Bool = true) -> [PondInspectorSection] {
        var s: [PondInspectorSection] = []
        if needsYou > 0 { s.append(.needsYou) }
        if ducks > 0 || canAddDuck { s.append(.ducks) }
        s.append(.people)
        return s
    }

    /// The ducks waiting on the person, newest first (ties by name): on duty, state waiting, with a chat to open.
    public static func needsYou(_ threads: [RoomThread]) -> [InspectorNeedsYouRow] {
        threads.filter { $0.state == .waiting && $0.onDuty && !$0.sessionId.isEmpty }
            .sorted { a, b in
                let ka = a.lastActiveAt ?? a.lastAt ?? 0, kb = b.lastActiveAt ?? b.lastAt ?? 0
                return ka != kb ? ka > kb : (a.duckName.lowercased(), a.sessionId) < (b.duckName.lowercased(), b.sessionId)
            }
            .map { InspectorNeedsYouRow(sessionId: $0.sessionId, name: $0.duckName, colourSeed: $0.colourSeed ?? $0.sessionId, agent: $0.agent, text: needsYouText($0.ask)) }
    }

    public static func needsYouText(_ ask: RoomAsk?) -> String {
        let line = ask?.question.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty }
        return line.map { "asks: \($0)" } ?? "wants approval"
    }

    /// The widest the Dashboard's own content gets: it shows streams, threads and work, centred.
    public static let dashboardContentWidth = 740.0
}
