import Foundation

// The pond room's wire shapes (`GET /native/projects/<id>/room`). Every field is read leniently: an unknown kind or
// level reads as a message in the room, a missing optional is nil, so a newer host never breaks the app.

public enum RoomAuthorKind: String, Sendable, Equatable { case person, agent, squeak }
public enum RoomPostKind: String, Sendable, Equatable { case working, done, needs, message, handoff }
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

public struct RoomPost: Sendable, Equatable, Decodable, Identifiable {
    public var seq: Int
    public var id: String
    public var author: RoomAuthor
    public var sessionId: String?
    public var kind: RoomPostKind
    public var level: RoomLevel
    public var text: String
    public var toSessionId: String?
    /// Milliseconds since 1970.
    public var at: Int64

    public init(
        seq: Int, id: String, author: RoomAuthor, sessionId: String? = nil, kind: RoomPostKind = .message,
        level: RoomLevel = .room, text: String, toSessionId: String? = nil, at: Int64
    ) {
        self.seq = seq; self.id = id; self.author = author; self.sessionId = sessionId; self.kind = kind
        self.level = level; self.text = text; self.toSessionId = toSessionId; self.at = at
    }

    private enum CodingKeys: String, CodingKey { case seq, id, author, sessionId, kind, level, text, toSessionId, at }
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
    public var id: String { sessionId }

    public init(
        sessionId: String, title: String, agent: String? = nil, state: RoomThreadState, workingOn: String? = nil, workingOnAt: Int64? = nil,
        lastState: String? = nil, lastAt: Int64? = nil, progress: RoomProgress? = nil, ask: RoomAsk? = nil, turnStartedAt: Int64? = nil, filesChanged: Int? = nil
    ) {
        self.sessionId = sessionId; self.title = title; self.agent = agent; self.state = state
        self.workingOn = workingOn; self.workingOnAt = workingOnAt; self.lastState = lastState; self.lastAt = lastAt
        self.progress = progress; self.ask = ask; self.turnStartedAt = turnStartedAt; self.filesChanged = filesChanged
    }

    private enum CodingKeys: String, CodingKey {
        case sessionId, title, agent, state, workingOn, workingOnAt, lastState, lastAt, progress, ask, turnStartedAt, filesChanged
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
    public init(letter: String, question: String) { self.letter = letter; self.question = question }
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

    public init(
        id: String, sessionId: String, threadTitle: String, agent: String? = nil, startedAt: Int64, endedAt: Int64? = nil,
        outcome: RoomTurnOutcome? = nil, prompt: String = "", author: RoomTurnAuthor = RoomTurnAuthor(name: ""), answer: RoomTurnAnswer? = nil,
        outcomeText: String? = nil, durationMs: Int64? = nil, filesChanged: Int? = nil, intent: String? = nil, progress: RoomProgress? = nil
    ) {
        self.id = id; self.sessionId = sessionId; self.threadTitle = threadTitle; self.agent = agent; self.startedAt = startedAt
        self.endedAt = endedAt; self.outcome = outcome; self.prompt = prompt; self.author = author; self.answer = answer
        self.outcomeText = outcomeText; self.durationMs = durationMs; self.filesChanged = filesChanged; self.intent = intent; self.progress = progress
    }

    private enum CodingKeys: String, CodingKey {
        case id, sessionId, threadTitle, agent, startedAt, endedAt, outcome, prompt, author, answer, outcomeText, durationMs, filesChanged, intent, progress
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
    }
}

public struct RoomPage: Sendable, Equatable, Decodable {
    public var posts: [RoomPost]
    public var latestSeq: Int
    public var threads: [RoomThread]
    /// Room v2: nil when the host does not serve turns (the feed then falls back to posts).
    public var turns: [RoomTurn]?

    public init(posts: [RoomPost] = [], latestSeq: Int = 0, threads: [RoomThread] = [], turns: [RoomTurn]? = nil) {
        self.posts = posts; self.latestSeq = latestSeq; self.threads = threads; self.turns = turns
    }

    private enum CodingKeys: String, CodingKey { case posts, latestSeq, threads, turns }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        posts = ((try? c.decode([Failable<RoomPost>].self, forKey: .posts)) ?? []).compactMap(\.value)
        threads = ((try? c.decode([Failable<RoomThread>].self, forKey: .threads)) ?? []).compactMap(\.value)
        latestSeq = (try? c.decode(Int.self, forKey: .latestSeq)) ?? posts.map(\.seq).max() ?? 0
        turns = (try? c.decode([Failable<RoomTurn>].self, forKey: .turns)).map { $0.compactMap(\.value) }
    }
}
