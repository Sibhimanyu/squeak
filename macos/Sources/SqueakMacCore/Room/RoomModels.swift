import Foundation

// The pond room's wire shapes (`GET /native/projects/<id>/room`). Every field is read leniently: an unknown kind or
// level reads as a message in the room, a missing optional is nil, so a newer host never breaks the app.

public enum RoomAuthorKind: String, Sendable, Equatable { case person, agent, squeak }
public enum RoomPostKind: String, Sendable, Equatable { case working, done, needs, message, handoff, plan }
public enum RoomLevel: String, Sendable, Equatable { case room, agents }

public struct RoomAuthor: Sendable, Equatable, Decodable {
    public var kind: RoomAuthorKind
    public var id: String?
    public var name: String

    public init(kind: RoomAuthorKind, id: String? = nil, name: String) { self.kind = kind; self.id = id; self.name = name }

    private enum CodingKeys: String, CodingKey { case kind, id, name }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? c.decode(String.self, forKey: .kind)).flatMap(RoomAuthorKind.init(rawValue:)) ?? .agent
        id = try? c.decode(String.self, forKey: .id)
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
    }
}

/// A canvas the Task made or changed, on a duck's done line. The host attaches it; the duck says nothing about it.
public struct RoomCanvasCard: Sendable, Equatable, Decodable, Identifiable {
    /// The wire id a Member's Mac asks for the view-only bundle by.
    public var id: String
    /// The canvas folder on the Owner's Mac.
    public var path: String
    public var title: String
    public var kind: String
    public var artboards: Int

    public init(id: String, path: String = "", title: String, kind: String, artboards: Int) {
        self.id = id; self.path = path; self.title = title; self.kind = kind; self.artboards = artboards
    }

    private enum CodingKeys: String, CodingKey { case id, path, title, kind, artboards }
    /// A Member's card has no folder (it stays on the Owner's Mac): `path` is empty and the card opens by `id`.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        path = (try? c.decode(String.self, forKey: .path)) ?? ""
        title = try c.decode(String.self, forKey: .title)
        kind = (try? c.decode(String.self, forKey: .kind)) ?? ""
        artboards = (try? c.decode(Int.self, forKey: .artboards)) ?? 0
    }

    /// "Deck \u{00B7} 3 artboards".
    public var subtitle: String {
        let name = kind.isEmpty ? "Canvas" : kind.prefix(1).uppercased() + kind.dropFirst()
        return "\(name) \u{00B7} \(artboards) \(artboards == 1 ? "artboard" : "artboards")"
    }

    /// What the canvas opens by: the Owner's own folder, or (for a Member) the id of the Owner's view-only bundle.
    public func openPath(memberView: Bool) -> String { memberView ? id : path }
}

public struct RoomPost: Sendable, Equatable, Decodable, Identifiable {
    public var seq: Int
    public var id: String
    public var author: RoomAuthor
    public var sessionId: String?
    public var kind: RoomPostKind
    public var level: RoomLevel
    public var text: String
    public var toSessionId: String?
    /// The receiving duck's name, decided by the host (the chat title when it has no name); nil for a host that sends none.
    public var toName: String?
    /// What a one-line status post expands to (a spec+plan card's body); nil for a host that sends none.
    public var detail: String?
    /// The spec+plan card a person's comment is on.
    public var replyTo: String?
    /// Pictures and files a person attached; empty for a host that does not send them.
    public var attachments: [RoomAttachment] = []
    /// The canvases the Task made or changed (a done line); empty for a host that sends none.
    public var canvases: [RoomCanvasCard] = []
    /// The Duck's turn the post came from (the host's bare turn id or `<sessionId>:<turnId>`), so a tap opens its chat at that
    /// turn. Optional: a host that sends none opens the chat at its end.
    public var turnId: String?
    /// The host wrote this post itself from the turn's result because the Duck did not post: shown with a quiet "written by Squeak".
    public var fallback: Bool = false
    /// Milliseconds since 1970.
    public var at: Int64

    public init(
        seq: Int, id: String, author: RoomAuthor, sessionId: String? = nil, kind: RoomPostKind = .message,
        level: RoomLevel = .room, text: String, toSessionId: String? = nil, detail: String? = nil, replyTo: String? = nil,
        attachments: [RoomAttachment] = [], turnId: String? = nil, fallback: Bool = false, at: Int64
    ) {
        self.turnId = turnId; self.fallback = fallback
        self.detail = detail; self.replyTo = replyTo
        self.seq = seq; self.id = id; self.author = author; self.sessionId = sessionId; self.kind = kind
        self.level = level; self.text = text; self.toSessionId = toSessionId; self.attachments = attachments; self.at = at
    }

    private enum CodingKeys: String, CodingKey { case seq, id, author, sessionId, kind, level, text, toSessionId, toName, detail, replyTo, attachments, canvases, turnId, fallback, at }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // A post with no seq or id cannot be placed; the page drops it (see `Failable`).
        seq = try c.decode(Int.self, forKey: .seq)
        id = try c.decode(String.self, forKey: .id)
        author = (try? c.decode(RoomAuthor.self, forKey: .author)) ?? RoomAuthor(kind: .agent, name: "")
        sessionId = try? c.decode(String.self, forKey: .sessionId)
        kind = (try? c.decode(String.self, forKey: .kind)).flatMap(RoomPostKind.init(rawValue:)) ?? .message
        level = (try? c.decode(String.self, forKey: .level)).flatMap(RoomLevel.init(rawValue:)) ?? .room
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
        toSessionId = try? c.decode(String.self, forKey: .toSessionId)
        toName = (try? c.decode(String.self, forKey: .toName)).flatMap { $0.isEmpty ? nil : $0 }
        detail = try? c.decode(String.self, forKey: .detail)
        replyTo = try? c.decode(String.self, forKey: .replyTo)
        attachments = ((try? c.decode([Failable<RoomAttachment>].self, forKey: .attachments)) ?? []).compactMap(\.value)
        canvases = ((try? c.decode([Failable<RoomCanvasCard>].self, forKey: .canvases)) ?? []).compactMap(\.value)
        turnId = (try? c.decode(String.self, forKey: .turnId)).flatMap { $0.isEmpty ? nil : $0 }
        fallback = (try? c.decode(Bool.self, forKey: .fallback)) ?? false
        at = (try? c.decode(Int64.self, forKey: .at)) ?? 0
    }
}

public enum RoomThreadState: String, Sendable, Equatable { case working, waiting, idle, error }

public struct RoomThread: Sendable, Equatable, Decodable, Identifiable {
    public var sessionId: String
    public var title: String
    public var agent: String?
    public var state: RoomThreadState
    public var workingOn: String?
    public var workingOnAt: Int64?
    /// How its last turn ended: finished, stopped, error or idle. Nil from an older host.
    public var lastState: String?
    /// Milliseconds since 1970 of that end (else the chat's last activity).
    public var lastAt: Int64?
    /// Room v2 (all optional: an older host sends none). `set_progress`, the open question with its lettered options,
    /// the current turn's start (ms) and the stream's changed-file count.
    public var progress: RoomProgress?
    public var ask: RoomAsk?
    public var turnStartedAt: Int64?
    public var filesChanged: Int?
    /// Ducks (CONTRACT-ducks): the person's chosen name (else the title), a one-line role, on/off duty and the last activity.
    /// All optional: an older host sends none (name = title, duty = on).
    public var name: String?
    public var role: String?
    public var duty: RoomDuty
    public var lastActiveAt: Int64?
    /// Pond-level ducks: the duck's own id, the seed its colour comes from, and where it works. All optional (older host).
    public var duckId: String?
    public var colourSeed: String?
    public var place: RoomPlace?
    /// The Streams the Duck has joined, in join order; empty when none (or an older host).
    public var streams: [RoomStream] = []
    /// An Off-duty Duck's last summary line, when the host has one.
    public var lastSummary: String?
    public var id: String { sessionId }

    /// The duck's name: the chosen one, else the chat's title.
    public var duckName: String {
        if let n = name?.trimmingCharacters(in: .whitespaces), !n.isEmpty { return n }
        let t = title.trimmingCharacters(in: .whitespaces)
        return t.isEmpty ? "Duck" : t
    }
    public var onDuty: Bool { duty == .on }
    /// What the Duck is known by in lists: its name on duty; its chat title off duty (names are masks).
    public var heading: String { onDuty ? duckName : RoomRoster.offDutyHeading(title: title) }

    public init(
        sessionId: String, title: String, agent: String? = nil, state: RoomThreadState, workingOn: String? = nil, workingOnAt: Int64? = nil,
        lastState: String? = nil, lastAt: Int64? = nil, progress: RoomProgress? = nil, ask: RoomAsk? = nil, turnStartedAt: Int64? = nil, filesChanged: Int? = nil,
        name: String? = nil, role: String? = nil, duty: RoomDuty = .on, lastActiveAt: Int64? = nil
    ) {
        self.name = name; self.role = role; self.duty = duty; self.lastActiveAt = lastActiveAt
        self.sessionId = sessionId; self.title = title; self.agent = agent; self.state = state
        self.workingOn = workingOn; self.workingOnAt = workingOnAt; self.lastState = lastState; self.lastAt = lastAt
        self.progress = progress; self.ask = ask; self.turnStartedAt = turnStartedAt; self.filesChanged = filesChanged
    }

    private enum CodingKeys: String, CodingKey {
        case sessionId, title, agent, state, workingOn, workingOnAt, lastState, lastAt, progress, ask, turnStartedAt, filesChanged
        case name, role, duty, lastActiveAt, duckId, colourSeed, place, streams, lastSummary
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        agent = try? c.decode(String.self, forKey: .agent)
        state = (try? c.decode(String.self, forKey: .state)).flatMap(RoomThreadState.init(rawValue:)) ?? .idle
        workingOn = (try? c.decode(String.self, forKey: .workingOn)).flatMap { $0.isEmpty ? nil : $0 }
        workingOnAt = try? c.decode(Int64.self, forKey: .workingOnAt)
        lastState = try? c.decode(String.self, forKey: .lastState)
        lastAt = try? c.decode(Int64.self, forKey: .lastAt)
        progress = try? c.decode(RoomProgress.self, forKey: .progress)
        ask = (try? c.decode(RoomAsk.self, forKey: .ask)).flatMap { $0.options.isEmpty && $0.question.isEmpty ? nil : $0 }
        turnStartedAt = try? c.decode(Int64.self, forKey: .turnStartedAt)
        filesChanged = try? c.decode(Int.self, forKey: .filesChanged)
        name = (try? c.decode(String.self, forKey: .name)).flatMap { $0.isEmpty ? nil : $0 }
        role = (try? c.decode(String.self, forKey: .role)).flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
        duty = (try? c.decode(String.self, forKey: .duty)).flatMap(RoomDuty.init(rawValue:)) ?? .on
        lastActiveAt = try? c.decode(Int64.self, forKey: .lastActiveAt)
        duckId = (try? c.decode(String.self, forKey: .duckId)).flatMap { $0.isEmpty ? nil : $0 }
        colourSeed = (try? c.decode(String.self, forKey: .colourSeed)).flatMap { $0.isEmpty ? nil : $0 }
        place = try? c.decode(RoomPlace.self, forKey: .place)
        lastSummary = (try? c.decode(String.self, forKey: .lastSummary)).flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
        streams = c.streams(forKey: .streams)
    }
}

/// Where a duck works: a stream (a branch of the pond's repository). Absent: Main, a plain folder, or no job yet.
public struct RoomPlace: Sendable, Equatable, Decodable {
    public var kind: String
    public var workspaceId: String?
    public var branch: String?
    public init(kind: String = "stream", workspaceId: String? = nil, branch: String? = nil) { self.kind = kind; self.workspaceId = workspaceId; self.branch = branch }
}

public enum RoomDuty: String, Sendable, Equatable { case on, off }

public enum RoomDucklingState: String, Sendable, Equatable { case running, done, failed }

public struct RoomDuckling: Sendable, Equatable, Decodable, Identifiable {
    public var label: String
    public var state: RoomDucklingState
    public var id: String { label }
    public init(label: String, state: RoomDucklingState = .running) { self.label = label; self.state = state }
    private enum CodingKeys: String, CodingKey { case label, state }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = try c.decode(String.self, forKey: .label)
        state = (try? c.decode(String.self, forKey: .state)).flatMap(RoomDucklingState.init(rawValue:)) ?? .running
    }
}

/// The subagents of one turn ("handed 2 pieces to ducklings").
public struct RoomDucklings: Sendable, Equatable, Decodable {
    public var count: Int
    public var done: Int
    public var items: [RoomDuckling]
    public init(count: Int, done: Int = 0, items: [RoomDuckling] = []) { self.count = count; self.done = done; self.items = items }
    private enum CodingKeys: String, CodingKey { case count, done, items }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let items = ((try? c.decode([Failable<RoomDuckling>].self, forKey: .items)) ?? []).compactMap(\.value)
        let n = (try? c.decode(Int.self, forKey: .count)) ?? items.count
        guard n >= 1 else { throw DecodingError.dataCorruptedError(forKey: .count, in: c, debugDescription: "count") }
        count = n
        done = (try? c.decode(Int.self, forKey: .done)) ?? items.filter { $0.state == .done }.count
        self.items = items
    }
}

/// "3 of 5". A total below one reads as no progress.
public struct RoomProgress: Sendable, Equatable, Decodable {
    public var current: Int
    public var total: Int
    public var label: String?
    public init(current: Int, total: Int, label: String? = nil) { self.current = current; self.total = total; self.label = label }
    private enum CodingKeys: String, CodingKey { case current, total, label }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        current = try c.decode(Int.self, forKey: .current)
        total = try c.decode(Int.self, forKey: .total)
        label = try? c.decode(String.self, forKey: .label)
        guard total >= 1 else { throw DecodingError.dataCorruptedError(forKey: .total, in: c, debugDescription: "total") }
    }
    /// 0...1 for the bar.
    public var fraction: Double { total > 0 ? min(1, max(0, Double(current) / Double(total))) : 0 }
}

public struct RoomAskOption: Sendable, Equatable, Decodable, Identifiable {
    public var letter: String
    public var text: String
    public var recommended: Bool
    public var id: String { letter }
    public init(letter: String, text: String, recommended: Bool = false) { self.letter = letter; self.text = text; self.recommended = recommended }
    private enum CodingKeys: String, CodingKey { case letter, text, recommended }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        letter = try c.decode(String.self, forKey: .letter)
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
        recommended = (try? c.decode(Bool.self, forKey: .recommended)) ?? false
    }
}

/// The question a needs-you thread is waiting on, with its lettered options (may be none: a free-text question).
public struct RoomAsk: Sendable, Equatable, Decodable {
    public var question: String
    public var options: [RoomAskOption]
    public init(question: String, options: [RoomAskOption] = []) { self.question = question; self.options = options }
    private enum CodingKeys: String, CodingKey { case question, options }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        question = (try? c.decode(String.self, forKey: .question)) ?? ""
        options = ((try? c.decode([Failable<RoomAskOption>].self, forKey: .options)) ?? []).compactMap(\.value)
    }
}

public enum RoomTurnOutcome: String, Sendable, Equatable { case finished, stopped, error }

public struct RoomTurnAuthor: Sendable, Equatable, Decodable {
    public var name: String
    public var me: Bool
    public init(name: String, me: Bool = false) { self.name = name; self.me = me }
    private enum CodingKeys: String, CodingKey { case name, me }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        me = (try? c.decode(Bool.self, forKey: .me)) ?? false
    }
}

public struct RoomTurnAnswer: Sendable, Equatable, Decodable {
    public var letter: String
    public var question: String
    /// The chosen option's own text, when the host matched it ("A \u{2014} <option>"); nil from an older host.
    public var option: String?
    public init(letter: String, question: String, option: String? = nil) { self.letter = letter; self.question = question; self.option = option }
    private enum CodingKeys: String, CodingKey { case letter, question, option }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        letter = try c.decode(String.self, forKey: .letter)
        question = try c.decode(String.self, forKey: .question)
        option = (try? c.decode(String.self, forKey: .option)).flatMap { $0.isEmpty ? nil : $0 }
    }
}

/// One turn of a thread (room v2): its id is `<sessionId>:<turnId>` and the same id is updated in place.
public struct RoomTurn: Sendable, Equatable, Decodable, Identifiable {
    public var id: String
    public var sessionId: String
    public var threadTitle: String
    public var agent: String?
    public var startedAt: Int64
    public var endedAt: Int64?
    /// Nil while the turn runs.
    public var outcome: RoomTurnOutcome?
    public var prompt: String
    public var author: RoomTurnAuthor
    public var answer: RoomTurnAnswer?
    public var outcomeText: String?
    public var durationMs: Int64?
    public var filesChanged: Int?
    public var intent: String?
    public var progress: RoomProgress?
    public var ducklings: RoomDucklings?

    public init(
        id: String, sessionId: String, threadTitle: String, agent: String? = nil, startedAt: Int64, endedAt: Int64? = nil,
        outcome: RoomTurnOutcome? = nil, prompt: String = "", author: RoomTurnAuthor = RoomTurnAuthor(name: ""), answer: RoomTurnAnswer? = nil,
        outcomeText: String? = nil, durationMs: Int64? = nil, filesChanged: Int? = nil, intent: String? = nil, progress: RoomProgress? = nil, ducklings: RoomDucklings? = nil
    ) {
        self.ducklings = ducklings
        self.id = id; self.sessionId = sessionId; self.threadTitle = threadTitle; self.agent = agent; self.startedAt = startedAt
        self.endedAt = endedAt; self.outcome = outcome; self.prompt = prompt; self.author = author; self.answer = answer
        self.outcomeText = outcomeText; self.durationMs = durationMs; self.filesChanged = filesChanged; self.intent = intent; self.progress = progress
    }

    private enum CodingKeys: String, CodingKey {
        case id, sessionId, threadTitle, agent, startedAt, endedAt, outcome, prompt, author, answer, outcomeText, durationMs, filesChanged, intent, progress, ducklings
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // A turn with no id, session or start cannot be placed; the page drops it.
        id = try c.decode(String.self, forKey: .id)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        startedAt = try c.decode(Int64.self, forKey: .startedAt)
        threadTitle = (try? c.decode(String.self, forKey: .threadTitle)) ?? ""
        agent = try? c.decode(String.self, forKey: .agent)
        endedAt = try? c.decode(Int64.self, forKey: .endedAt)
        outcome = (try? c.decode(String.self, forKey: .outcome)).flatMap(RoomTurnOutcome.init(rawValue:))
        prompt = (try? c.decode(String.self, forKey: .prompt)) ?? ""
        author = (try? c.decode(RoomTurnAuthor.self, forKey: .author)) ?? RoomTurnAuthor(name: "")
        answer = try? c.decode(RoomTurnAnswer.self, forKey: .answer)
        outcomeText = (try? c.decode(String.self, forKey: .outcomeText)).flatMap { $0.isEmpty ? nil : $0 }
        durationMs = try? c.decode(Int64.self, forKey: .durationMs)
        filesChanged = try? c.decode(Int.self, forKey: .filesChanged)
        intent = (try? c.decode(String.self, forKey: .intent)).flatMap { $0.isEmpty ? nil : $0 }
        progress = try? c.decode(RoomProgress.self, forKey: .progress)
        ducklings = try? c.decode(RoomDucklings.self, forKey: .ducklings)
    }
}

public struct RoomPage: Sendable, Equatable, Decodable {
    public var posts: [RoomPost]
    public var latestSeq: Int
    public var threads: [RoomThread]
    /// Room v2: nil when the host does not serve turns (the feed then falls back to posts).
    public var turns: [RoomTurn]?
    /// Room jobs: nil when the host does not serve them (the room then shows nothing new).
    public var tasks: [RoomTask]?
    /// A Member's page only: the one sentence shown while the Owner's Mac is not running ("Sam's Mac is offline; ...").
    public var ownerOffline: String?
    /// A Member's page only: false when the Owner turned off messaging for this Member (the Room is read-only).
    public var canPost: Bool

    public init(posts: [RoomPost] = [], latestSeq: Int = 0, threads: [RoomThread] = [], turns: [RoomTurn]? = nil, tasks: [RoomTask]? = nil, ownerOffline: String? = nil, canPost: Bool = true) {
        self.posts = posts; self.latestSeq = latestSeq; self.threads = threads; self.turns = turns; self.tasks = tasks
        self.ownerOffline = ownerOffline; self.canPost = canPost
    }

    private enum CodingKeys: String, CodingKey { case posts, latestSeq, threads, turns, tasks, ownerOffline, canPost }
    private struct OfflineLine: Decodable { var line: String? }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        posts = ((try? c.decode([Failable<RoomPost>].self, forKey: .posts)) ?? []).compactMap(\.value)
        threads = ((try? c.decode([Failable<RoomThread>].self, forKey: .threads)) ?? []).compactMap(\.value)
        latestSeq = (try? c.decode(Int.self, forKey: .latestSeq)) ?? posts.map(\.seq).max() ?? 0
        turns = (try? c.decode([Failable<RoomTurn>].self, forKey: .turns)).map { $0.compactMap(\.value) }
        tasks = (try? c.decode([Failable<RoomTask>].self, forKey: .tasks)).map { $0.compactMap(\.value) }
        ownerOffline = (try? c.decode(OfflineLine.self, forKey: .ownerOffline))?.line
        canPost = (try? c.decode(Bool.self, forKey: .canPost)) ?? true
    }
}
