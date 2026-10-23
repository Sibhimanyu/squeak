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
    /// The estimated cost of the whole session so far, when the model is priced.
    public var costUsd: Double?
    /// The question a finished session's last message closes on ("Want me to open a PR?"). Present means the
    /// agent waits on an answer: the daemon counts it as needing you, and so does this app. Nil from an older daemon.
    public var asks: String?

    enum CodingKeys: String, CodingKey {
        case key, agent, origin, originLabel, source, state, title, repoName, branch, cwd
        case lastActivityAt, contextPercent, alive, conductorSessionId, conductorWorkspaceId
        case replyTarget, distinctTitle, costUsd, asks
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
        costUsd = c.lenient(Double.self, .costUsd)
        asks = DaemonSession.cleaned(c.lenient(String.self, .asks))
    }

    private static func cleaned(_ s: String?) -> String? {
        guard let s = s?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return s
    }

    public init(key: String) { self.key = key }
}

/// Claude Code's plan limits as `/state` reports them (`claudeLimits`).
struct DaemonClaudeLimits: Decodable, Equatable {
    struct Window: Decodable, Equatable {
        var utilization: Double
        var resetsAt: String
    }
    var fiveHour: Window?
    var sevenDay: Window?
    var observedAt: String?

    var usage: ProviderUsage {
        func window(_ w: Window?) -> UsageWindow? {
            w.map { UsageWindow(usedPercent: min(max($0.utilization, 0), 1) * 100, resetsAt: DaemonDate.parse($0.resetsAt)) }
        }
        return ProviderUsage(fiveHour: window(fiveHour), longWindow: window(sevenDay), observedAt: observedAt.flatMap(DaemonDate.parse))
    }
}

/// Codex's account quota as `/state` reports it (`codexUsage`).
struct DaemonCodexUsage: Decodable, Equatable {
    struct Window: Decodable, Equatable {
        var usedPercent: Double
        var resetsAt: String
    }
    var primary: Window?
    var secondary: Window?
    var observedAt: String?

    var usage: ProviderUsage {
        func window(_ w: Window?) -> UsageWindow? {
            w.map { UsageWindow(usedPercent: min(max($0.usedPercent, 0), 100), resetsAt: DaemonDate.parse($0.resetsAt)) }
        }
        return ProviderUsage(fiveHour: window(primary), longWindow: window(secondary), observedAt: observedAt.flatMap(DaemonDate.parse))
    }
}

/// The Mac's awake session as `/state` reports it (`awake`): absent when none runs.
public struct DaemonAwake: Decodable, Sendable, Equatable {
    public var until: Date?
    public var lid: Bool
    enum CodingKeys: String, CodingKey { case until, lid }
    public init(until: Date?, lid: Bool = false) { self.until = until; self.lid = lid }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        until = c.lenient(String.self, .until).flatMap(DaemonDate.parse)
        lid = c.lenient(Bool.self, .lid) ?? false
    }
}

/// Hotspot failover as `/state` reports it (`hotspot`); never the password.
public struct DaemonHotspot: Decodable, Sendable, Equatable {
    public var configured: Bool
    public var ssid: String?
    public var enabled: Bool
    public var onHotspot: Bool
    public init(configured: Bool, ssid: String?, enabled: Bool, onHotspot: Bool) {
        self.configured = configured; self.ssid = ssid; self.enabled = enabled; self.onHotspot = onHotspot
    }
}

public struct DaemonState: Decodable, Sendable, Equatable {
    public var generatedAt: Date?
    public var sessions: [DaemonSession]
    public var claudeUsage: ProviderUsage?
    public var codexUsage: ProviderUsage?
    /// The awake session, when one runs; nil from a daemon without them too.
    public var awake: DaemonAwake?
    /// Whether this daemon offers awake sessions at all (`keepAwake` present).
    public var awakeOffered = false
    /// Whether a lid-closed session can start: the sudoers rule is installed.
    public var awakeLidReady = false
    public var hotspot: DaemonHotspot?

    enum CodingKeys: String, CodingKey { case generatedAt, active, others, claudeLimits, codexUsage, awake, keepAwake, awakeLidReady, hotspot }

    /// Both readings and today's estimated cost, for the usage screens.
    public func usage(now: Date = Date(), calendar: Calendar = .current) -> UsageSnapshot {
        let cost = UsageFormat.cost(of: sessions.map { ($0.lastActivityAt, $0.costUsd) }, now: now, calendar: calendar)
        return UsageSnapshot(
            claude: claudeUsage, codex: codexUsage,
            todayCostUsd: cost.sessions > 0 ? cost.usd : nil, todayCostSessions: cost.sessions)
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let s = c.lenient(String.self, .generatedAt) { generatedAt = DaemonDate.parse(s) }
        let active = (c.lenient([Failable<DaemonSession>].self, .active) ?? []).compactMap(\.value)
        let others = (c.lenient([Failable<DaemonSession>].self, .others) ?? []).compactMap(\.value)
        var seen = Set<String>()
        // A session can be listed once; first listing (active) wins.
        sessions = (active + others).filter { !$0.key.isEmpty && seen.insert($0.key).inserted }
        claudeUsage = c.lenient(DaemonClaudeLimits.self, .claudeLimits)?.usage
        codexUsage = c.lenient(DaemonCodexUsage.self, .codexUsage)?.usage
        let keepAwake = c.lenient(Bool.self, .keepAwake)
        awakeOffered = keepAwake != nil
        awake = keepAwake == true ? (c.lenient(DaemonAwake.self, .awake) ?? DaemonAwake(until: nil)) : nil
        awakeLidReady = c.lenient(Bool.self, .awakeLidReady) ?? false
        hotspot = c.lenient(DaemonHotspot.self, .hotspot)
    }

    public init(generatedAt: Date? = nil, sessions: [DaemonSession], claudeUsage: ProviderUsage? = nil, codexUsage: ProviderUsage? = nil) {
        self.generatedAt = generatedAt
        self.sessions = sessions
        self.claudeUsage = claudeUsage
        self.codexUsage = codexUsage
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

struct DaemonClaudeRefreshBody: Decodable {
    var claudeLimits: DaemonClaudeLimits?
    var throttled: Bool?
    var refreshed: Bool?
    var error: String?
    enum CodingKeys: String, CodingKey { case claudeLimits, throttled, refreshed, error }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        claudeLimits = c.lenient(DaemonClaudeLimits.self, .claudeLimits)
        throttled = c.lenient(Bool.self, .throttled)
        refreshed = c.lenient(Bool.self, .refreshed)
        error = c.lenient(String.self, .error)
    }
}

struct DaemonReplyBody: Decodable {
    var status: String?
    var via: String?
    var reason: String?
    var fallbackReason: String?
    var delivery: String?
    var note: String?
    enum CodingKeys: String, CodingKey { case status, via, reason, fallbackReason, delivery, note }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = c.lenient(String.self, .status)
        via = c.lenient(String.self, .via)
        reason = c.lenient(String.self, .reason)
        fallbackReason = c.lenient(String.self, .fallbackReason)
        delivery = c.lenient(String.self, .delivery)
        note = c.lenient(String.self, .note)
    }
}

/// What the daemon says about a Conductor chat's closing question, for the local adapter to lay over a chat
/// it reads itself: the daemon alone reads the agent's last message.
public struct DaemonAskView: Sendable, Equatable {
    public var state: String?
    public var lastActivityAt: Date?
    public var asks: String?
    public init(state: String?, lastActivityAt: Date?, asks: String?) {
        self.state = state; self.lastActivityAt = lastActivityAt; self.asks = asks
    }
}
