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
    public var id: String { sessionId }

    public init(sessionId: String, title: String, agent: String? = nil, state: RoomThreadState, workingOn: String? = nil, workingOnAt: Int64? = nil, lastState: String? = nil, lastAt: Int64? = nil) {
        self.sessionId = sessionId; self.title = title; self.agent = agent; self.state = state
        self.workingOn = workingOn; self.workingOnAt = workingOnAt; self.lastState = lastState; self.lastAt = lastAt
    }

    private enum CodingKeys: String, CodingKey { case sessionId, title, agent, state, workingOn, workingOnAt, lastState, lastAt }
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
    }
}

public struct RoomPage: Sendable, Equatable, Decodable {
    public var posts: [RoomPost]
    public var latestSeq: Int
    public var threads: [RoomThread]

    public init(posts: [RoomPost] = [], latestSeq: Int = 0, threads: [RoomThread] = []) {
        self.posts = posts; self.latestSeq = latestSeq; self.threads = threads
    }

    private enum CodingKeys: String, CodingKey { case posts, latestSeq, threads }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        posts = ((try? c.decode([Failable<RoomPost>].self, forKey: .posts)) ?? []).compactMap(\.value)
        threads = ((try? c.decode([Failable<RoomThread>].self, forKey: .threads)) ?? []).compactMap(\.value)
        latestSeq = (try? c.decode(Int.self, forKey: .latestSeq)) ?? posts.map(\.seq).max() ?? 0
    }
}
