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
    public var isOpen: Bool
    public var currentSessionId: String?
    /// The Streams it has joined, in join order; empty when none.
    public var streams: [RoomStream] = []
    /// What the host's roster says it is doing: working includes Ducklings still working; the one rule for every surface.
    public var activity: PondDuckActivity = .idle
    /// How many Ducklings run for it now.
    public var ducklingsRunning = 0
    /// The host-written status line ("Working \u{00B7} 1 duckling on x", "Needs you", "Idle \u{00B7} 4m", "Closed 3d ago").
    public var statusLine: String?
    /// The host's heading: the name while open, the chat title when closed.
    public var hostHeading: String?
    /// The host says this Duck needs the person by the one rule (`needs-you.ts`): waiting, or a failure not yet seen. Open or closed.
    public var needsYou = false
    /// Why (`approval`, `question`, `looping`, `stalled`, `failed`); nil when it does not.
    public var needsYouReason: String?
    /// The failure's own words when `needsYouReason` is `failed`, so a badge says why without opening the chat.
    public var failure: String?
    /// The Stream chips as the host writes them: each Stream's branch, or "Pond" when it is in none.
    public var streamLabels: [String] = []
    public var state: RoomThreadState
    public var lastActiveAt: Int64?
    public var createdAt: Int64?
    /// The chat's title (what the Duck is used for), when the host sends one.
    public var title: String?
    /// Names are masks worn while open: the host sends no name for a Closed Duck.
    public var wearsName = true
    /// The chat's title: what a Closed Duck is known by (names are masks, worn while open).
    public var chatTitle: String?
    /// A Closed Duck's last summary line (what it last reported finishing), when the host has one.
    public var lastSummary: String?

    public init(
        id: String, name: String, role: String? = nil, colourSeed: String? = nil, isOpen: Bool = true, currentSessionId: String? = nil,
        state: RoomThreadState = .idle, lastActiveAt: Int64? = nil, createdAt: Int64? = nil,
        streams: [RoomStream] = [], title: String? = nil, wearsName: Bool = true, chatTitle: String? = nil, lastSummary: String? = nil,
        ducklingsRunning: Int = 0, statusLine: String? = nil, heading: String? = nil, streamLabels: [String] = []
    ) {
        self.ducklingsRunning = ducklingsRunning; self.statusLine = statusLine; self.hostHeading = heading
        self.streamLabels = streamLabels.isEmpty ? Self.labels(of: streams) : streamLabels
        self.activity = Self.activity(of: state)
        self.title = title ?? chatTitle; self.wearsName = wearsName; self.chatTitle = chatTitle ?? title; self.lastSummary = lastSummary
        self.streams = streams
        self.id = id; self.name = name; self.role = role; self.colourSeed = colourSeed ?? id; self.isOpen = isOpen
        self.currentSessionId = currentSessionId; self.state = state; self.lastActiveAt = lastActiveAt; self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey { case id, name, role, colourSeed, open, olderDuty = "duty", currentSessionId, streams, state, activity, ducklingsRunning, statusLine, heading, streamLabels, lastActiveAt, createdAt, title, chatTitle, lastSummary, needsYou, needsYouReason, failure }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        let sent = (try? c.decode(String.self, forKey: .name)).flatMap { $0.isEmpty ? nil : $0 }
        wearsName = sent != nil
        title = (try? c.decode(String.self, forKey: .title)).flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
        name = sent ?? "Duck"
        role = (try? c.decode(String.self, forKey: .role)).flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
        colourSeed = (try? c.decode(String.self, forKey: .colourSeed)).flatMap { $0.isEmpty ? nil : $0 } ?? id
        isOpen = c.duckIsOpen(.open, olderKey: .olderDuty)
        currentSessionId = (try? c.decode(String.self, forKey: .currentSessionId)).flatMap { $0.isEmpty ? nil : $0 }
        streams = c.streams(forKey: .streams)
        state = (try? c.decode(String.self, forKey: .state)).flatMap(RoomThreadState.init(rawValue:)) ?? .idle
        activity = (try? c.decode(String.self, forKey: .activity)).flatMap(PondDuckActivity.init(rawValue:)) ?? Self.activity(of: state)
        ducklingsRunning = (try? c.decode(Int.self, forKey: .ducklingsRunning)) ?? 0
        // An older host does not say: only a chat waiting on the person counts, as it always did.
        needsYou = (try? c.decode(Bool.self, forKey: .needsYou)) ?? (activity == .needsYou)
        needsYouReason = (try? c.decode(String.self, forKey: .needsYouReason)).flatMap { $0.isEmpty ? nil : $0 }
        failure = (try? c.decode(String.self, forKey: .failure)).flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
        statusLine = (try? c.decode(String.self, forKey: .statusLine)).flatMap { $0.isEmpty ? nil : $0 }
        hostHeading = (try? c.decode(String.self, forKey: .heading)).flatMap { $0.isEmpty ? nil : $0 }
        let labels = (try? c.decode([String].self, forKey: .streamLabels)) ?? []
        streamLabels = labels.isEmpty ? Self.labels(of: streams) : labels
        lastActiveAt = try? c.decode(Int64.self, forKey: .lastActiveAt)
        createdAt = try? c.decode(Int64.self, forKey: .createdAt)
        chatTitle = (try? c.decode(String.self, forKey: .chatTitle)).flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
        if title == nil { title = chatTitle } else if chatTitle == nil { chatTitle = title }
        lastSummary = (try? c.decode(String.self, forKey: .lastSummary)).flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
    }

    static func activity(of state: RoomThreadState) -> PondDuckActivity {
        state == .working ? .working : (state == .waiting ? .needsYou : (state == .error ? .error : .idle))
    }

    static func labels(of streams: [RoomStream]) -> [String] {
        streams.isEmpty ? [DuckStreams.pondLabel] : streams.map { $0.branch.isEmpty ? ($0.title ?? "Stream") : $0.branch }
    }
}

/// A Duck's activity as the host decides it: working means its turn runs or its Ducklings still work.
public enum PondDuckActivity: String, Sendable, Equatable { case working, needsYou, idle, error }

/// One roster row, ready to draw.
public struct RosterDuck: Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var colourSeed: String
    public var agent: String?
    public var agentLabel: String?
    public var role: String?
    public var presence: RoomDuckPresence
    public var presenceLine: String
    /// The duck's current chat: nil until it has had a job.
    public var sessionId: String?
    /// The Streams it is in (join order); empty when it works in the Pond itself.
    public var streams: [RoomStream] = []
    /// The chat's title, and whether the Duck's name is worn (open with a name from the host).
    public var title: String?
    public var wearsName = true
    /// The chat's title and a Closed Duck's last summary line (see `PondDuck`).
    public var chatTitle: String?
    public var lastSummary: String?
    /// How many Ducklings run for it now, and the host's status line and heading (drawn as sent).
    public var ducklingsRunning = 0
    public var statusLine: String?
    public var hostHeading: String?
    /// The Stream chips: "Pond" when it is in none.
    public var streamLabels: [String] = []
    public var lastActiveAt: Int64?
    public var activity: PondDuckActivity = .idle
    /// The host's one "needs you" rule (see `PondDuck.needsYou`), whether open or closed.
    public var needsYou = false
    public var needsYouReason: String?
    public var failure: String?
    public var isOpen: Bool { presence != .off }
    /// The row's heading: the host's; else an open Duck's name or a Closed Duck's chat title (it wears no name).
    public var heading: String { hostHeading ?? (isOpen ? name : RoomRoster.closedHeading(title: chatTitle)) }
    public var hasJob: Bool { sessionId != nil }
}

public struct DuckRoster: Sendable, Equatable {
    public var open: [RosterDuck]
    public var closed: [RosterDuck]
    public var count: Int { open.count + closed.count }
    /// The default list: Available ducks only.
    public var available: [RosterDuck] { open }
}

public enum RoomRoster {
    public static let noJobLine = "No job yet \u{2014} say something in the room or Give it a job"

    /// Open ducks newest activity first, then closed ducks the same way; ties by name then id, so rows move only for real
    /// activity. `threads` supplies what the duck route does not carry (agent, progress), matched by the duck's current session.
    public static func roster(_ ducks: [PondDuck], threads: [RoomThread] = [], now: Date = Date()) -> DuckRoster {
        func key(_ d: PondDuck) -> Int64 { d.lastActiveAt ?? d.createdAt ?? 0 }
        let sorted = ducks.sorted { a, b in
            if key(a) != key(b) { return key(a) > key(b) }
            return (a.name.lowercased(), a.id) < (b.name.lowercased(), b.id)
        }
        let rows = sorted.map { row($0, thread: $0.currentSessionId.flatMap { s in threads.first { $0.sessionId == s } }, now: now) }
        return DuckRoster(open: rows.filter(\.isOpen), closed: rows.filter { !$0.isOpen })
    }

    public static func row(_ d: PondDuck, thread: RoomThread? = nil, now: Date = Date()) -> RosterDuck {
        let presence: RoomDuckPresence = !d.isOpen ? .off : (d.activity == .working ? .working : (d.activity == .needsYou ? .waiting : .idle))
        return RosterDuck(
            id: d.id, name: d.name, colourSeed: d.colourSeed, agent: thread?.agent, agentLabel: RoomDucks.agentLabel(thread?.agent), role: d.role,
            presence: presence, presenceLine: presenceLine(d, thread: thread, presence: presence, now: now),
            sessionId: d.currentSessionId, streams: d.streams,
            title: thread?.title ?? d.title, wearsName: d.wearsName && presence != .off,
            chatTitle: d.chatTitle ?? thread?.title, lastSummary: d.lastSummary, ducklingsRunning: d.ducklingsRunning,
            statusLine: d.statusLine, hostHeading: d.hostHeading, streamLabels: d.streamLabels, lastActiveAt: d.lastActiveAt, activity: d.activity,
            needsYou: d.needsYou, needsYouReason: d.needsYouReason, failure: d.failure)
    }

    /// A Closed Duck's heading: its chat title, else "Untitled chat".
    public static func closedHeading(title: String?) -> String {
        let t = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return t.isEmpty ? "Untitled chat" : t
    }

    /// "Closed 3d ago" (just "Closed" when the host gave no time).
    public static func closedAgo(_ at: Int64?, now: Date) -> String {
        guard let at, at > 0 else { return "Closed" }
        return "Closed \(RoomDucks.ago(at, now: now))"
    }

    /// "Working \u{00B7} 3 of 5", "Waiting on you", "Idle \u{00B7} 2h ago", "Closed", "Ready for a job" (no session yet).
    public static func presenceLine(_ d: PondDuck, thread: RoomThread?, presence: RoomDuckPresence, now: Date) -> String {
        if let line = d.statusLine { return line }
        switch presence {
        case .off: return closedAgo(d.lastActiveAt, now: now)
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
    /// host returned, Available and Closed, by name or role (case and accent insensitive, every word must match); Available
    /// ones come first, Closed ones follow greyed (`isOpen == false`) so the row offers Reopen.
    public static func visible(_ ducks: [PondDuck], threads: [RoomThread] = [], query: String, now: Date = Date()) -> [RosterDuck] {
        let r = roster(ducks, threads: threads, now: now)
        let words = query.split(whereSeparator: \.isWhitespace).map(String.init)
        if words.isEmpty { return r.available }
        func hit(_ d: RosterDuck) -> Bool {
            // A Closed Duck is found by its chat title and last summary; an open one by its name.
            let hay = (d.isOpen ? d.name : d.heading + " " + (d.lastSummary ?? "")) + " " + (d.role ?? "")
            return words.allSatisfy { hay.range(of: $0, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
        }
        return (r.open + r.closed).filter(hit)
    }

    /// The collapsed "Closed" group under the Available ducks: the most recently active Closed ducks, capped; `more` is how
    /// many the search still holds.
    public static let closedCap = 20
    public static func closedGroup(_ ducks: [PondDuck], threads: [RoomThread] = [], now: Date = Date()) -> (rows: [RosterDuck], more: Int) {
        let off = roster(ducks, threads: threads, now: now).closed
        return (Array(off.prefix(closedCap)), max(0, off.count - closedCap))
    }
    /// The line under a capped Closed group.
    public static func closedMoreLine(_ n: Int) -> String { "+\(n) more \u{2014} search to find them" }
    /// Nothing Available, some closed: the Available part of the list says so instead of looking empty.
    public static let noneOpenLine = "No ducks open."

    /// "No duck called \u{201C}x\u{201D}", for a search that finds nothing.
    public static func noMatchLine(_ query: String) -> String {
        "No duck called \u{201C}\(query.trimmingCharacters(in: .whitespacesAndNewlines))\u{201D}"
    }
    public static let searchPrompt = "Find a duck"
    public static let bringBackTitle = "Reopen"
    /// The default list with nothing Available while some ducks are closed.
    public static let noneAvailableLine = "No ducks available. Search to bring one back."

    /// The heading's count and label: "Ducks \u{00B7} 5" (Available ducks).
    public static func header(_ n: Int) -> String { "Ducks \u{00B7} \(n)" }
    public static func closedLabel(_ n: Int) -> String { "Closed \u{00B7} \(n)" }

    /// A thread's duck (or the duck route's, by id) replaced or added: optimistic updates reconcile by duck id.
    public static func upserting(_ d: PondDuck, into list: [PondDuck]) -> [PondDuck] {
        var l = list
        if let i = l.firstIndex(where: { $0.id == d.id }) { l[i] = d } else { l.append(d) }
        return l
    }

    /// What a click on a duck does: open its tab, or nothing (with the line to show) while it has no job.
    public enum Click: Sendable, Equatable { case open(sessionId: String), noJob(String) }
    public static func click(_ d: RosterDuck) -> Click { d.sessionId.map { .open(sessionId: $0) } ?? .noJob(noJobLine) }

    /// What a click does once the chats the app knows are looked at: the row click and the hover Open share this. A duck whose
    /// chat is not among `known` says "Couldn't open <name>" rather than doing nothing.
    public enum Opening: Sendable, Equatable { case open(sessionId: String), noJob(String), failed(String) }
    public static func opening(_ d: RosterDuck, known: some Collection<String>) -> Opening {
        switch click(d) {
        case .noJob(let line): return .noJob(line)
        case .open(let id):
            guard let resolved = PondOpenResolver.sessionId(for: id, among: known) else { return .failed(PondOpenResolver.failureNote(name: d.name)) }
            return .open(sessionId: resolved)
        }
    }

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
    case setOpen(duck: String, open: Bool)

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
        case .setOpen(let duck, let open):
            return Request(method: "POST", path: "/native/ducks/\(NativeHostClient.id(duck))/state", body: .object(["open": .bool(open)]))
        }
    }
}

/// The duck routes (an absent route answers nil/false so the caller can fall back to the room page's threads).
public struct DuckClient: Sendable {
    let host: NativeHostClient
    public init(host: NativeHostClient) { self.host = host }

    public func list(project: String) async throws -> [PondDuck]? { try await roster(project: project)?.ducks }

    /// The ducks and the daemon's dashboard `counts` (nil from an older daemon).
    public func roster(project: String) async throws -> (ducks: [PondDuck], counts: PondCounts?)? {
        struct R: Decodable { var ducks: [LossyDuck]; var counts: PondCounts? }
        let r = DuckAction.list(project: project)
        do {
            let data = try await host.call(r.method, r.path, timeout: 10)
            do { let d = try JSONDecoder().decode(R.self, from: data); return (d.ducks.compactMap(\.duck), d.counts) } catch { throw NativeHostError.badResponse }
        } catch where PondsClient.isAbsent(error) { return nil }
    }

    /// Runs a create / rename / role / open-or-closed request; answers the duck as the host now has it.
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

    /// The ducks waiting on the person, newest first (ties by name): open, state waiting, with a chat to open.
    public static func needsYou(_ threads: [RoomThread]) -> [InspectorNeedsYouRow] {
        threads.filter { $0.state == .waiting && $0.isOpen && !$0.sessionId.isEmpty }
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
