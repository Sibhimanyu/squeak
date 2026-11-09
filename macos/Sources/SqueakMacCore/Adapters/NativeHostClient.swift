import Foundation

// Squeak's own session host (`squeak host`, 127.0.0.1:8479, src/native/server.ts): the chats Squeak runs itself.
// Same token file and header as the daemon's control routes, no CORS. Transport and token are injected so tests
// never touch the network or the real token file.

/// A JSON value from the host: message payloads are the agent's own shapes, read by `NativeTranscript`.
public indirect enum NativeJSON: Sendable, Equatable, Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([NativeJSON])
    case object([String: NativeJSON])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([NativeJSON].self) { self = .array(a) }
        else if let o = try? c.decode([String: NativeJSON].self) { self = .object(o) }
        else { self = .null }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    public static func parse(_ json: String) -> NativeJSON? {
        try? JSONDecoder().decode(NativeJSON.self, from: Data(json.utf8))
    }

    public subscript(key: String) -> NativeJSON? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    public var string: String? { if case .string(let s) = self { return s }; return nil }
    public var bool: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var array: [NativeJSON]? { if case .array(let a) = self { return a }; return nil }
    public var object: [String: NativeJSON]? { if case .object(let o) = self { return o }; return nil }
    public var int: Int? { if case .number(let n) = self, n.isFinite { return Int(n) }; return nil }
    public var double: Double? { if case .number(let n) = self, n.isFinite { return n }; return nil }
    public var isNull: Bool { if case .null = self { return true }; return false }
}

public struct NativeSession: Sendable, Equatable, Decodable, Identifiable {
    public var id: String
    public var workspaceId: String?
    public var cwd: String
    /// `claude` or `codex`.
    public var agent: String
    public var agentSessionId: String?
    public var title: String?
    public var model: String
    public var effort: String?
    public var permissionMode: String
    /// idle, working, needs_user_permission, needs_plan_response, needs_user_input, cancelling, error.
    public var status: String
    public var createdAt: Date?
    public var updatedAt: Date?
    public var lastTurnEndedAt: Date?
    public var prunedThrough: Int

    enum CodingKeys: String, CodingKey {
        case id, workspaceId, cwd, agent, agentSessionId, title, model, effort, permissionMode, status
        case createdAt, updatedAt, lastTurnEndedAt, prunedThrough
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        workspaceId = c.lenient(String.self, .workspaceId)
        cwd = c.lenient(String.self, .cwd) ?? ""
        agent = c.lenient(String.self, .agent) ?? "claude"
        agentSessionId = c.lenient(String.self, .agentSessionId)
        title = c.lenient(String.self, .title)
        model = c.lenient(String.self, .model) ?? ""
        effort = c.lenient(String.self, .effort)
        permissionMode = c.lenient(String.self, .permissionMode) ?? "default"
        status = c.lenient(String.self, .status) ?? "idle"
        createdAt = c.lenient(String.self, .createdAt).flatMap(DaemonDate.parse)
        updatedAt = c.lenient(String.self, .updatedAt).flatMap(DaemonDate.parse)
        lastTurnEndedAt = c.lenient(String.self, .lastTurnEndedAt).flatMap(DaemonDate.parse)
        prunedThrough = c.lenient(Int.self, .prunedThrough) ?? 0
    }

    public init(
        id: String, cwd: String = "", agent: String = "claude", title: String? = nil, model: String = "", effort: String? = nil,
        permissionMode: String = "default", status: String = "idle", workspaceId: String? = nil, updatedAt: Date? = nil,
        lastTurnEndedAt: Date? = nil
    ) {
        self.id = id; self.cwd = cwd; self.agent = agent; self.title = title; self.model = model; self.effort = effort
        self.permissionMode = permissionMode; self.status = status; self.workspaceId = workspaceId
        self.updatedAt = updatedAt; self.lastTurnEndedAt = lastTurnEndedAt
        agentSessionId = nil; createdAt = nil; prunedThrough = 0
    }
}

/// One stored row: the agent's own message, verbatim in `payload`.
public struct NativeMessage: Sendable, Equatable, Decodable {
    public var seq: Int
    public var sessionId: String
    /// user, agent or system.
    public var role: String
    /// `user/text`, `assistant`, `user`, `result/success`, `item/commandExecution`, `system/error` ...
    public var kind: String
    public var payload: NativeJSON
    public var createdAt: Date?

    enum CodingKeys: String, CodingKey { case seq, sessionId, role, kind, payload, createdAt }

    public init(seq: Int, sessionId: String = "s", role: String, kind: String, payload: NativeJSON, createdAt: Date? = nil) {
        self.seq = seq; self.sessionId = sessionId; self.role = role; self.kind = kind; self.payload = payload; self.createdAt = createdAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seq = try c.decode(Int.self, forKey: .seq)
        sessionId = c.lenient(String.self, .sessionId) ?? ""
        role = c.lenient(String.self, .role) ?? "agent"
        kind = c.lenient(String.self, .kind) ?? ""
        payload = c.lenient(NativeJSON.self, .payload) ?? .null
        createdAt = c.lenient(String.self, .createdAt).flatMap(DaemonDate.parse)
    }
}

/// A question the agent is waiting on a person for: a tool, a plan, an AskUserQuestion, a Codex command or file change.
/// One allow rule a chat keeps after "Allow for this session" (`GET /native/sessions/<id>/rules`).
public struct NativeRule: Sendable, Equatable, Decodable, Identifiable {
    public var id: String
    /// `tool` (every use of a tool), `bash-exact` (one command), anything else a command prefix.
    public var kind: String
    public var value: String

    public init(id: String, kind: String, value: String) { self.id = id; self.kind = kind; self.value = value }

    enum CodingKeys: String, CodingKey { case id, kind, value }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = c.lenient(String.self, .kind) ?? ""
        value = c.lenient(String.self, .value) ?? ""
    }

    /// The host's own wording (`describeRule`): a tool by name, an exact command as is, a prefix with an ellipsis.
    public var text: String {
        switch kind {
        case "tool": "\(value) (any use)"
        case "bash-exact": value
        default: "\(value) …"
        }
    }
}

public struct NativeRequest: Sendable, Equatable, Decodable, Identifiable {
    public var id: String
    public var sessionId: String
    /// tool, plan, question, command, file_change.
    public var kind: String
    /// Claude: `toolName`, `input` (a plan's text is `input.plan`, a question's `input.questions`), `title`,
    /// `description`, `blockedPath`. Codex: the app-server request's params (`command`, `cwd`, `reason`, `item`).
    public var payload: NativeJSON
    public var createdAt: Date?

    enum CodingKeys: String, CodingKey { case id, sessionId, kind, payload, createdAt }

    public init(id: String, sessionId: String = "s", kind: String, payload: NativeJSON, createdAt: Date? = nil) {
        self.id = id; self.sessionId = sessionId; self.kind = kind; self.payload = payload; self.createdAt = createdAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        sessionId = c.lenient(String.self, .sessionId) ?? ""
        kind = c.lenient(String.self, .kind) ?? "tool"
        payload = c.lenient(NativeJSON.self, .payload) ?? .null
        createdAt = c.lenient(String.self, .createdAt).flatMap(DaemonDate.parse)
    }
}

public struct NativeQueueItem: Sendable, Equatable, Decodable, Identifiable {
    public var id: String
    public var text: String
    public var createdAt: Date?

    enum CodingKeys: String, CodingKey { case id, text, createdAt }

    public init(id: String, text: String, createdAt: Date? = nil) { self.id = id; self.text = text; self.createdAt = createdAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        text = c.lenient(String.self, .text) ?? ""
        createdAt = c.lenient(String.self, .createdAt).flatMap(DaemonDate.parse)
    }
}

/// Where a new workspace starts (`from` on `POST /native/projects/<id>/workspaces`).
public enum NativeWorkspaceSource: Sendable, Equatable {
    /// That branch itself, checked out.
    case branch(String)
    /// A new branch cut from that one, which becomes the target.
    case base(String)
    case pullRequest(Int)
    case issue(Int)

    var json: NativeJSON {
        switch self {
        case .branch(let b): .object(["kind": .string("branch"), "branch": .string(b)])
        case .base(let b): .object(["kind": .string("base"), "branch": .string(b)])
        case .pullRequest(let n): .object(["kind": .string("pr"), "number": .number(Double(n))])
        case .issue(let n): .object(["kind": .string("issue"), "number": .number(Double(n))])
        }
    }

    /// What the person typed: "#12", "12", a GitHub PR or issue URL, or a branch name.
    public static func parse(_ input: String, as kind: String) -> NativeWorkspaceSource? {
        let t = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return nil }
        func number() -> Int? {
            let last = t.split(separator: "/").last.map(String.init) ?? t
            return Int(last.hasPrefix("#") ? String(last.dropFirst()) : last).flatMap { $0 > 0 ? $0 : nil }
        }
        switch kind {
        case "pr": return number().map { .pullRequest($0) }
        case "issue": return number().map { .issue($0) }
        case "base": return t.contains(" ") ? nil : .base(t)
        default: return t.contains(" ") ? nil : .branch(t)
        }
    }
}

public struct NativeBacklogItem: Sendable, Equatable, Decodable, Identifiable {
    public var id: String
    public var title: String
    public var prompt: String
}

/// A prompt that starts a chat on a schedule (host `planner.ts`).
public struct NativeRoutine: Sendable, Equatable, Decodable, Identifiable {
    public struct Schedule: Sendable, Equatable, Decodable {
        public var kind: String
        public var every: Int?
        public var at: String?
        public var day: Int?
    }
    public var id: String
    public var title: String
    public var prompt: String
    public var schedule: Schedule
    public var agent: String
    public var model: String
    public var enabled: Bool
    public var newWorkspace: Bool
    public var lastRunAt: String?
    public var lastError: String?
    public var nextRunAt: String?

    /// "Every 6 hours", "Daily at 09:00", "Mondays at 08:00".
    public var scheduleWords: String {
        switch schedule.kind {
        case "hourly": let n = schedule.every ?? 1; return n == 1 ? "Every hour" : "Every \(n) hours"
        case "weekly":
            let days = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"]
            return "\(days[min(6, max(0, schedule.day ?? 0))]) at \(schedule.at ?? "?")"
        default: return "Daily at \(schedule.at ?? "?")"
        }
    }
}

public struct NativeRoutineDraft: Sendable, Equatable {
    public var prompt = ""
    /// hourly, daily or weekly.
    public var kind = "daily"
    public var every = 6
    public var at = "09:00"
    public var day = 1
    public var agent = "claude"
    public var model = ""
    public var newWorkspace = true

    public init() {}

    public var isValid: Bool {
        !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.isEmpty
            && (kind == "hourly" ? (1...168).contains(every) : at.range(of: #"^([01]\d|2[0-3]):[0-5]\d$"#, options: .regularExpression) != nil)
    }

    var json: NativeJSON {
        let schedule: NativeJSON = switch kind {
        case "hourly": .object(["kind": .string("hourly"), "every": .number(Double(every))])
        case "weekly": .object(["kind": .string("weekly"), "day": .number(Double(day)), "at": .string(at)])
        default: .object(["kind": .string("daily"), "at": .string(at)])
        }
        return .object([
            "prompt": .string(prompt), "schedule": schedule, "agent": .string(agent), "model": .string(model),
            "newWorkspace": .bool(newWorkspace),
        ])
    }
}

public struct NativeCreatedWorkspace: Sendable, Equatable, Decodable {
    public var workspace: NativeWorkspace
    /// A suggested first message (an issue's).
    public var prompt: String?
    public var title: String?
}

public struct NativeProject: Sendable, Equatable, Decodable, Identifiable {
    public var id: String
    public var name: String
    public var rootPath: String
    public var defaultBranch: String

    public init(id: String, name: String, rootPath: String, defaultBranch: String) {
        self.id = id; self.name = name; self.rootPath = rootPath; self.defaultBranch = defaultBranch
    }
}

public struct NativeWorkspace: Sendable, Equatable, Decodable, Identifiable {
    public var id: String
    public var projectId: String
    public var name: String
    public var path: String
    public var branch: String
    /// ready, setting_up, setup_failed or archived (a host that does not say is read as ready).
    public var state: String
    /// First of the block of ten ports reserved for the workspace's scripts.
    public var port: Int?

    enum CodingKeys: String, CodingKey { case id, projectId, name, path, branch, state, port }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        projectId = c.lenient(String.self, .projectId) ?? ""
        name = c.lenient(String.self, .name) ?? ""
        path = c.lenient(String.self, .path) ?? ""
        branch = c.lenient(String.self, .branch) ?? ""
        state = c.lenient(String.self, .state) ?? "ready"
        port = c.lenient(Int.self, .port)
    }

    public init(id: String, projectId: String, name: String, path: String, branch: String, state: String = "ready", port: Int? = nil) {
        self.id = id; self.projectId = projectId; self.name = name; self.path = path; self.branch = branch; self.state = state
        self.port = port
    }
}

/// What a new native chat needs (`POST /native/sessions`).
public struct NativeNewSession: Sendable, Equatable {
    public var agent: String
    public var model: String
    public var permissionMode: String
    public var effort: String?
    public var cwd: String?
    public var projectId: String?
    public var newWorkspace: Bool
    public var text: String?

    public init(
        agent: String, model: String, permissionMode: String = "default", effort: String? = nil, cwd: String? = nil,
        projectId: String? = nil, newWorkspace: Bool = false, text: String? = nil
    ) {
        self.agent = agent; self.model = model; self.permissionMode = permissionMode; self.effort = effort
        self.cwd = cwd; self.projectId = projectId; self.newWorkspace = newWorkspace; self.text = text
    }
}

/// Failures of a host call, split by whether anything could have reached the host.
public enum NativeHostError: Error, Equatable, Sendable {
    /// Nothing is listening on the host's port: the request was never written.
    case hostDown
    case tokenMissing
    case tokenRejected
    /// The host answered with an error; `message` is its own fixed sentence ("can't steer", "no such session").
    case http(Int, String?)
    /// Timed out or dropped after the request was written: it may have been processed.
    case uncertain(String)
    case badResponse

    /// The words to show, never a body or a token.
    public var reason: String {
        switch self {
        case .hostDown: "Squeak's session host isn't running"
        case .tokenMissing: "Squeak's access token was not found"
        case .tokenRejected: "Squeak rejected the access token"
        case .http(_, let m): m ?? "Squeak's session host refused that"
        case .uncertain(let m): m
        case .badResponse: "Squeak's session host answered something unreadable"
        }
    }

    var adapterError: AdapterError {
        switch self {
        case .hostDown: .daemonDown
        case .tokenMissing: .tokenMissing
        case .tokenRejected: .tokenRejected
        case .http(let c, _): .http(c)
        case .uncertain: .timedOut
        case .badResponse: .badResponse("unreadable session host answer")
        }
    }
}

/// What a control press on a native chat did. Never retried.
public enum NativeActionResult: Sendable, Equatable {
    case done
    /// The host said no, in its own sentence (409 "can't steer", "already resolved"): nothing changed.
    case refused(reason: String)
    case failed(reason: String)
}

// MARK: Stream events

/// One event of a chat's `/stream`. Messages are persisted (`seq`); a delta is ephemeral text.
public enum NativeEvent: Sendable, Equatable {
    case message(NativeMessage)
    /// A partial stream chunk: Claude's `stream_event`, Codex's `item/agentMessage/delta`. Never stored.
    case delta(NativeJSON)
    case status(String)
    case request(NativeRequest)
    case requestResolved(String)
    case queueChanged
    /// What the reader had is gone from the host (pruned, or the host's database was reset): refetch the transcript.
    case reset(lastSeq: Int, prunedThrough: Int)
}

struct SSEFrame: Equatable {
    var event: String
    var data: String
    var id: String?
}

/// Server-Sent Events by the line: a blank line ends a frame, `:` lines are comments.
struct SSEParser {
    private var event = ""
    private var data: [String] = []
    private var id: String?

    mutating func feed(_ line: String) -> SSEFrame? {
        if line.isEmpty {
            defer { event = ""; data = []; id = nil }
            guard !data.isEmpty || !event.isEmpty else { return nil }
            return SSEFrame(event: event.isEmpty ? "message" : event, data: data.joined(separator: "\n"), id: id)
        }
        if line.hasPrefix(":") { return nil }
        let (field, value): (Substring, Substring)
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            var rest = line[line.index(after: colon)...]
            if rest.hasPrefix(" ") { rest = rest.dropFirst() }
            value = rest
        } else {
            field = Substring(line); value = ""
        }
        switch field {
        case "event": event = String(value)
        case "data": data.append(String(value))
        case "id": id = String(value)
        default: break
        }
        return nil
    }
}

extension NativeEvent {
    static func from(_ frame: SSEFrame) -> NativeEvent? {
        let decoder = JSONDecoder()
        let bytes = Data(frame.data.utf8)
        switch frame.event {
        case "message": return (try? decoder.decode(NativeMessage.self, from: bytes)).map(NativeEvent.message)
        case "delta": return (try? decoder.decode(NativeJSON.self, from: bytes)).map(NativeEvent.delta)
        case "status": return (try? decoder.decode(NativeJSON.self, from: bytes))?["status"]?.string.map(NativeEvent.status)
        case "request": return (try? decoder.decode(NativeRequest.self, from: bytes)).map(NativeEvent.request)
        case "request-resolved": return (try? decoder.decode(NativeJSON.self, from: bytes))?["requestId"]?.string.map(NativeEvent.requestResolved)
        case "queue": return .queueChanged
        case "reset":
            let j = try? decoder.decode(NativeJSON.self, from: bytes)
            return .reset(lastSeq: j?["lastSeq"]?.int ?? 0, prunedThrough: j?["prunedThrough"]?.int ?? 0)
        default: return nil
        }
    }
}

// MARK: Client

public struct NativeHostClient: Sendable {
    public static let defaultPort = 8479

    public let baseURL: URL
    private let transport: any HTTPTransport
    private let tokenProvider: @Sendable () -> String?
    /// The lines of a streaming GET, empty lines included; ends (or throws) when the connection does.
    private let lineSource: @Sendable (HTTPRequest) -> AsyncThrowingStream<String, Error>

    public init(
        baseURL: URL, transport: any HTTPTransport = URLSessionTransport(), tokenProvider: @escaping @Sendable () -> String?,
        lineSource: @escaping @Sendable (HTTPRequest) -> AsyncThrowingStream<String, Error> = NativeHostClient.urlSessionLines
    ) {
        self.baseURL = baseURL
        self.transport = transport
        self.tokenProvider = tokenProvider
        self.lineSource = lineSource
    }

    /// Port from `SQUEAK_HOST_PORT`, else 8479; the token from the same file as the daemon's control routes.
    public static func live(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        tokenFile: URL = DaemonClient.defaultTokenFile,
        transport: any HTTPTransport = URLSessionTransport()
    ) -> NativeHostClient {
        let port = environment["SQUEAK_HOST_PORT"].flatMap { Int($0) } ?? defaultPort
        return NativeHostClient(
            baseURL: URL(string: "http://127.0.0.1:\(port)")!, transport: transport,
            tokenProvider: { DaemonClient.readToken(at: tokenFile) })
    }

    /// The host beside a given daemon client: same token source (and so the same fake in tests).
    public static func beside(
        _ daemon: DaemonClient, environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> NativeHostClient {
        let port = environment["SQUEAK_HOST_PORT"].flatMap { Int($0) } ?? defaultPort
        return NativeHostClient(
            baseURL: URL(string: "http://127.0.0.1:\(port)")!, transport: daemon.transportForControl,
            tokenProvider: daemon.tokenProvider)
    }

    public var hasToken: Bool { tokenProvider() != nil }

    // MARK: Sessions

    public func sessions() async throws -> [NativeSession] {
        try await decode(Sessions.self, try await call("GET", "/native/sessions")).sessions
    }

    /// nil when the host does not know the chat (404).
    public func session(id: String) async throws -> NativeSession? {
        do { return try await decode(One.self, try await call("GET", "/native/sessions/\(Self.id(id))")).session }
        catch NativeHostError.http(404, _) { return nil }
    }

    public func createSession(_ spec: NativeNewSession) async throws -> NativeSession {
        var body: [String: NativeJSON] = [
            "agent": .string(spec.agent), "model": .string(spec.model), "permissionMode": .string(spec.permissionMode),
        ]
        if let e = spec.effort { body["effort"] = .string(e) }
        if let c = spec.cwd { body["cwd"] = .string(c) }
        if let p = spec.projectId { body["projectId"] = .string(p) }
        if spec.newWorkspace { body["newWorkspace"] = .bool(true) }
        if let t = spec.text, !t.isEmpty { body["text"] = .string(t) }
        return try await decode(One.self, try await call("POST", "/native/sessions", body: .object(body), timeout: 30)).session
    }

    /// Sends a message; true when the host queued it behind a running turn. Never retried: a timeout is `uncertain`.
    public func send(id: String, text: String, mode: SendMode) async throws -> Bool {
        let r = try await call(
            "POST", "/native/sessions/\(Self.id(id))/messages",
            body: .object(["text": .string(text), "mode": .string(mode.rawValue)]), timeout: 20, maybeSent: true)
        return (try? JSONDecoder().decode(NativeJSON.self, from: r))?["queued"]?.bool ?? false
    }

    /// `limit` rows after `after`, oldest first.
    public func messages(id: String, after: Int = 0, limit: Int = 500) async throws -> [NativeMessage] {
        try await decode(Messages.self, try await call("GET", "/native/sessions/\(Self.id(id))/messages?after=\(after)&limit=\(limit)")).messages
    }

    /// The newest `limit` rows before `before` (nil: before everything), still oldest first.
    public func messages(id: String, before: Int?, limit: Int) async throws -> [NativeMessage] {
        let b = before.map(String.init) ?? "latest"
        return try await decode(Messages.self, try await call("GET", "/native/sessions/\(Self.id(id))/messages?before=\(b)&limit=\(limit)")).messages
    }

    public func interrupt(id: String) async throws {
        _ = try await call("POST", "/native/sessions/\(Self.id(id))/interrupt", body: .object([:]))
    }

    public func setMode(id: String, permissionMode: String) async throws {
        _ = try await call("POST", "/native/sessions/\(Self.id(id))/mode", body: .object(["permissionMode": .string(permissionMode)]))
    }

    /// Claude switches on its live process; Codex carries it on its next turn. `effort` nil keeps the chat's.
    public func setModel(id: String, model: String, effort: String? = nil) async throws {
        var body: [String: NativeJSON] = ["model": .string(model)]
        if let effort { body["effort"] = .string(effort) }
        _ = try await call("POST", "/native/sessions/\(Self.id(id))/model", body: .object(body))
    }

    public func respond(requestId: String, allow: Bool, message: String? = nil, answers: NativeJSON? = nil) async throws {
        var body: [String: NativeJSON] = ["decision": .string(allow ? "allow" : "deny")]
        if let message { body["message"] = .string(message) }
        if let answers { body["answers"] = answers }
        _ = try await call("POST", "/native/requests/\(Self.id(requestId))", body: .object(body))
    }

    /// Allows the request and keeps an allow rule for the chat (`scope: "session"`). A host without it answers 400.
    public func allowForSession(requestId: String) async throws {
        _ = try await call(
            "POST", "/native/requests/\(Self.id(requestId))",
            body: .object(["decision": .string("allow"), "scope": .string("session")]))
    }

    /// The chat's allow rules, oldest first; nil when the host does not have the route (404, an older host).
    public func rules(id: String) async throws -> [NativeRule]? {
        do { return try await decode(Rules.self, try await call("GET", "/native/sessions/\(Self.id(id))/rules")).rules }
        catch NativeHostError.http(404, _) { return nil }
    }

    public func removeRule(id: String, ruleId: String) async throws {
        _ = try await call("DELETE", "/native/sessions/\(Self.id(id))/rules/\(Self.id(ruleId))")
    }

    public func openRequests(id: String) async throws -> [NativeRequest] {
        try await decode(Requests.self, try await call("GET", "/native/sessions/\(Self.id(id))/requests")).requests
    }

    // MARK: Queue

    public func queue(id: String) async throws -> [NativeQueueItem] {
        try await decode(Queue.self, try await call("GET", "/native/sessions/\(Self.id(id))/queue")).queue
    }

    public func removeQueued(id: String, queueId: String) async throws {
        _ = try await call("DELETE", "/native/sessions/\(Self.id(id))/queue/\(Self.id(queueId))")
    }

    public func editQueued(id: String, queueId: String, text: String) async throws {
        _ = try await call("PATCH", "/native/sessions/\(Self.id(id))/queue/\(Self.id(queueId))", body: .object(["text": .string(text)]))
    }

    /// Codex: steers the running turn with it and removes it. Claude: 409 "can't steer", and the queue keeps it.
    public func steerQueued(id: String, queueId: String) async throws {
        _ = try await call("POST", "/native/sessions/\(Self.id(id))/queue/\(Self.id(queueId))/steer", body: .object([:]), timeout: 20)
    }

    // MARK: Projects and workspaces

    public func projects() async throws -> [NativeProject] {
        try await decode(Projects.self, try await call("GET", "/native/projects")).projects
    }

    public func addProject(rootPath: String) async throws -> NativeProject {
        try await decode(OneProject.self, try await call("POST", "/native/projects", body: .object(["rootPath": .string(rootPath)]), timeout: 30)).project
    }

    /// A project's workspaces, oldest first (`GET /native/projects/<id>/workspaces`).
    public func workspaces(projectId: String) async throws -> [NativeWorkspace] {
        try await decode(Workspaces.self, try await call("GET", "/native/projects/\(Self.id(projectId))/workspaces")).workspaces
    }

    public func createWorkspace(projectId: String) async throws -> NativeWorkspace {
        try await decode(OneWorkspace.self, try await call("POST", "/native/projects/\(Self.id(projectId))/workspaces", body: .object([:]), timeout: 60)).workspace
    }

    /// A workspace from a branch, a base, a pull request or an issue; the host fetches and asks GitHub first.
    public func createWorkspace(projectId: String, from source: NativeWorkspaceSource) async throws -> NativeCreatedWorkspace {
        try await decode(
            NativeCreatedWorkspace.self,
            try await call("POST", "/native/projects/\(Self.id(projectId))/workspaces", body: .object(["from": source.json]), timeout: 120))
    }

    // MARK: Backlog and routines

    public func backlog(projectId: String) async throws -> [NativeBacklogItem] {
        try await decode(BacklogList.self, try await call("GET", "/native/projects/\(Self.id(projectId))/backlog")).backlog
    }

    public func addBacklog(projectId: String, prompt: String) async throws -> NativeBacklogItem {
        try await decode(OneBacklog.self, try await call(
            "POST", "/native/projects/\(Self.id(projectId))/backlog", body: .object(["prompt": .string(prompt)]))).item
    }

    public func removeBacklog(id: String) async throws {
        _ = try await call("DELETE", "/native/backlog/\(Self.id(id))")
    }

    public func routines(projectId: String) async throws -> [NativeRoutine] {
        try await decode(RoutineList.self, try await call("GET", "/native/projects/\(Self.id(projectId))/routines")).routines
    }

    public func addRoutine(projectId: String, _ draft: NativeRoutineDraft) async throws -> NativeRoutine {
        try await decode(OneRoutine.self, try await call(
            "POST", "/native/projects/\(Self.id(projectId))/routines", body: draft.json)).routine
    }

    public func setRoutineEnabled(id: String, _ enabled: Bool) async throws -> NativeRoutine {
        try await decode(OneRoutine.self, try await call(
            "PATCH", "/native/routines/\(Self.id(id))", body: .object(["enabled": .bool(enabled)]))).routine
    }

    public func removeRoutine(id: String) async throws {
        _ = try await call("DELETE", "/native/routines/\(Self.id(id))")
    }

    public func runRoutine(id: String) async throws {
        _ = try await call("POST", "/native/routines/\(Self.id(id))/run", body: .object([:]), timeout: 120)
    }

    /// Clones `owner/repo`, an https URL or an ssh address into ~/squeak/repos and adds it as a project.
    public func cloneProject(url: String) async throws -> NativeProject {
        try await decode(OneProject.self, try await call("POST", "/native/projects/clone", body: .object(["url": .string(url)]), timeout: 900)).project
    }

    // MARK: Stream

    /// A chat's live events from `after`, reconnecting with the last seq it saw (the host replays what was missed).
    /// A `reset` means the host no longer has what the reader asked for: refetch, and the replay that follows is
    /// every message again, so consumers dedupe by `seq`. The stream ends only when the consumer stops iterating.
    public func stream(
        id: String, after: Int = 0, minBackoff: Duration = .seconds(1), maxBackoff: Duration = .seconds(10),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) -> AsyncStream<NativeEvent> {
        AsyncStream { continuation in
            let task = Task {
                var last = after
                var backoff = minBackoff
                while !Task.isCancelled {
                    guard let token = tokenProvider() else {
                        try? await sleep(maxBackoff)
                        continue
                    }
                    let request = HTTPRequest(
                        url: url("/native/sessions/\(Self.id(id))/stream?after=\(last)"), headers: ["x-squeak-token": token], timeout: 90)
                    var parser = SSEParser()
                    do {
                        for try await line in lineSource(request) {
                            guard let frame = parser.feed(line), let event = NativeEvent.from(frame) else { continue }
                            backoff = minBackoff
                            switch event {
                            case .message(let m): last = max(last, m.seq)
                            case .reset: last = 0
                            default: break
                            }
                            continuation.yield(event)
                        }
                    } catch NativeHostError.tokenRejected {
                        // A wrong token will not fix itself on the next try; wait the long time.
                        backoff = maxBackoff
                    } catch {}
                    if Task.isCancelled { break }
                    try? await sleep(backoff)
                    backoff = min(maxBackoff, backoff * 2)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// The real line source: URLSession bytes, split by hand because `bytes.lines` drops the blank lines SSE needs.
    @Sendable public static func urlSessionLines(_ request: HTTPRequest) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var r = URLRequest(url: request.url, timeoutInterval: request.timeout)
                for (k, v) in request.headers { r.setValue(v, forHTTPHeaderField: k) }
                r.setValue("text/event-stream", forHTTPHeaderField: "accept")
                let config = URLSessionConfiguration.ephemeral
                config.urlCache = nil
                config.waitsForConnectivity = false
                do {
                    let (bytes, response) = try await URLSession(configuration: config).bytes(for: r)
                    guard let http = response as? HTTPURLResponse else { throw NativeHostError.badResponse }
                    if http.statusCode == 401 || http.statusCode == 403 { throw NativeHostError.tokenRejected }
                    guard http.statusCode == 200 else { throw NativeHostError.http(http.statusCode, nil) }
                    var buffer: [UInt8] = []
                    for try await byte in bytes {
                        if byte == 10 {
                            if buffer.last == 13 { buffer.removeLast() }
                            continuation.yield(String(decoding: buffer, as: UTF8.self))
                            buffer.removeAll(keepingCapacity: true)
                        } else {
                            buffer.append(byte)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: Plumbing

    private struct Sessions: Decodable { var sessions: [NativeSession] }
    private struct One: Decodable { var session: NativeSession }
    private struct Messages: Decodable { var messages: [NativeMessage] }
    private struct Requests: Decodable { var requests: [NativeRequest] }
    private struct Rules: Decodable { var rules: [NativeRule] }
    private struct Queue: Decodable { var queue: [NativeQueueItem] }
    private struct Projects: Decodable { var projects: [NativeProject] }
    private struct OneProject: Decodable { var project: NativeProject }
    private struct BacklogList: Decodable { var backlog: [NativeBacklogItem] }
    private struct OneBacklog: Decodable { var item: NativeBacklogItem }
    private struct RoutineList: Decodable { var routines: [NativeRoutine] }
    private struct OneRoutine: Decodable { var routine: NativeRoutine }
    private struct Workspaces: Decodable { var workspaces: [NativeWorkspace] }
    private struct OneWorkspace: Decodable { var workspace: NativeWorkspace }

    /// A path segment: ids are plain tokens; anything else is percent-encoded so it can never add a segment.
    static func id(_ s: String) -> String { DaemonClient.encode(s) }

    private func url(_ pathAndQuery: String) -> URL {
        URL(string: baseURL.absoluteString + pathAndQuery) ?? baseURL
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try JSONDecoder().decode(type, from: data) } catch { throw NativeHostError.badResponse }
    }

    func call(
        _ method: String, _ path: String, body: NativeJSON? = nil, timeout: TimeInterval = 8, maybeSent: Bool = false
    ) async throws -> Data {
        guard let token = tokenProvider() else { throw NativeHostError.tokenMissing }
        var headers = ["x-squeak-token": token]
        var payload: Data?
        if let body {
            headers["content-type"] = "application/json"
            payload = try? JSONEncoder().encode(body)
        }
        let response: HTTPResponse
        do {
            response = try await transport.send(HTTPRequest(method: method, url: url(path), headers: headers, body: payload, timeout: timeout))
        } catch let e as TransportError {
            switch e {
            case .connectionRefused: throw NativeHostError.hostDown
            case .timedOut: throw maybeSent ? NativeHostError.uncertain("Squeak's session host didn't answer, so the message may or may not have gone. Check the chat.") : NativeHostError.uncertain("Squeak's session host didn't answer")
            case .connectionLost: throw maybeSent ? NativeHostError.uncertain("The connection to Squeak's session host dropped, so the message may or may not have gone. Check the chat.") : NativeHostError.hostDown
            case .other(let m): throw NativeHostError.uncertain(m)
            }
        }
        if response.status == 401 || response.status == 403 { throw NativeHostError.tokenRejected }
        guard (200..<300).contains(response.status) else {
            let message = (try? JSONDecoder().decode(NativeJSON.self, from: response.body))?["error"]?.string
            throw NativeHostError.http(response.status, message)
        }
        return response.body
    }
}
