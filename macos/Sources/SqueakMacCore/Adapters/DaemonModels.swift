import Foundation

extension KeyedDecodingContainer {
    /// Decodes a field, treating a missing key or a wrong type as nil.
    func lenient<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        (try? decodeIfPresent(type, forKey: key)) ?? nil
    }
}

private struct Failable<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

enum DaemonDate {
    static func parse(_ s: String) -> Date? {
        if let d = try? Date(s, strategy: .iso8601) { return d }
        let frac = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        return try? Date(s, strategy: frac)
    }
}

/// One session as `/state` reports it. Everything but `key` is optional.
public struct DaemonSession: Decodable, Sendable, Equatable {
    public var key: String
    public var agent: String?
    public var origin: String?
    public var originLabel: String?
    public var source: String?
    public var state: String?
    public var title: String?
    public var repoName: String?
    public var branch: String?
    public var cwd: String?
    public var lastActivityAt: Date?
    public var contextPercent: Double?
    public var alive: Bool?
    public var conductorSessionId: String?
    public var conductorWorkspaceId: String?
    public var replyTarget: String?
    public var distinctTitle: String?

    enum CodingKeys: String, CodingKey {
        case key, agent, origin, originLabel, source, state, title, repoName, branch, cwd
        case lastActivityAt, contextPercent, alive, conductorSessionId, conductorWorkspaceId
        case replyTarget, distinctTitle
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        agent = c.lenient(String.self, .agent)
        origin = c.lenient(String.self, .origin)
        originLabel = c.lenient(String.self, .originLabel)
        source = c.lenient(String.self, .source)
        state = c.lenient(String.self, .state)
        title = c.lenient(String.self, .title)
        repoName = c.lenient(String.self, .repoName)
        branch = c.lenient(String.self, .branch)
        cwd = c.lenient(String.self, .cwd)
        if let s = c.lenient(String.self, .lastActivityAt) {
            lastActivityAt = DaemonDate.parse(s)
        } else if let n = c.lenient(Double.self, .lastActivityAt) {
            lastActivityAt = Date(timeIntervalSince1970: n > 10_000_000_000 ? n / 1000 : n)
        }
        contextPercent = c.lenient(Double.self, .contextPercent)
        alive = c.lenient(Bool.self, .alive)
        conductorSessionId = c.lenient(String.self, .conductorSessionId)
        conductorWorkspaceId = c.lenient(String.self, .conductorWorkspaceId)
        replyTarget = c.lenient(String.self, .replyTarget)
        distinctTitle = c.lenient(String.self, .distinctTitle)
    }

    public init(key: String) { self.key = key }
}

public struct DaemonState: Decodable, Sendable, Equatable {
    public var generatedAt: Date?
    public var sessions: [DaemonSession]

    enum CodingKeys: String, CodingKey { case generatedAt, active, others }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let s = c.lenient(String.self, .generatedAt) { generatedAt = DaemonDate.parse(s) }
        let active = (c.lenient([Failable<DaemonSession>].self, .active) ?? []).compactMap(\.value)
        let others = (c.lenient([Failable<DaemonSession>].self, .others) ?? []).compactMap(\.value)
        var seen = Set<String>()
        // A session can be listed once; first listing (active) wins.
        sessions = (active + others).filter { !$0.key.isEmpty && seen.insert($0.key).inserted }
    }

    public init(generatedAt: Date? = nil, sessions: [DaemonSession]) {
        self.generatedAt = generatedAt
        self.sessions = sessions
    }
}

public struct DaemonTranscriptMessage: Decodable, Sendable, Equatable {
    public var id: String
    public var role: String
    public var text: String
    public var at: Date?
    public var turnId: String?

    enum CodingKeys: String, CodingKey { case id, role, text, at, turnId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        role = try c.decode(String.self, forKey: .role)
        text = c.lenient(String.self, .text) ?? ""
        if let s = c.lenient(String.self, .at) {
            at = DaemonDate.parse(s)
        } else if let n = c.lenient(Double.self, .at) {
            at = Date(timeIntervalSince1970: n > 10_000_000_000 ? n / 1000 : n)
        }
        turnId = c.lenient(String.self, .turnId)
    }
}

public struct DaemonTranscript: Decodable, Sendable, Equatable {
    public var messages: [DaemonTranscriptMessage]
    public var complete: Bool

    enum CodingKeys: String, CodingKey { case messages, complete }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        messages = (c.lenient([Failable<DaemonTranscriptMessage>].self, .messages) ?? []).compactMap(\.value)
        complete = c.lenient(Bool.self, .complete) ?? false
    }
}

public struct DaemonLastMessage: Decodable, Sendable, Equatable {
    public var text: String
    enum CodingKeys: String, CodingKey { case text }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = c.lenient(String.self, .text) ?? ""
    }
}

public struct DaemonActivity: Decodable, Sendable, Equatable {
    public struct Step: Decodable, Sendable, Equatable {
        public var kind: String
        public var text: String
        public var at: Date?
        enum CodingKeys: String, CodingKey { case kind, text, at }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            kind = c.lenient(String.self, .kind) ?? "note"
            text = c.lenient(String.self, .text) ?? ""
            if let s = c.lenient(String.self, .at) {
                at = DaemonDate.parse(s)
            } else if let n = c.lenient(Double.self, .at) {
                at = Date(timeIntervalSince1970: n > 10_000_000_000 ? n / 1000 : n)
            }
        }
    }
    public var steps: [Step]
    enum CodingKeys: String, CodingKey { case steps }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        steps = (c.lenient([Failable<Step>].self, .steps) ?? []).compactMap(\.value)
    }
}

struct DaemonReplyBody: Decodable {
    var status: String?
    var via: String?
    var reason: String?
    var fallbackReason: String?
    enum CodingKeys: String, CodingKey { case status, via, reason, fallbackReason }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = c.lenient(String.self, .status)
        via = c.lenient(String.self, .via)
        reason = c.lenient(String.self, .reason)
        fallbackReason = c.lenient(String.self, .fallbackReason)
    }
}
