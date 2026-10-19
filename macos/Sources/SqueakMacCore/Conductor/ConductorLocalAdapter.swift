import Foundation

/// Delivers a message into an existing Conductor chat. The relay provides the real one.
public protocol ConductorSender: Sendable {
    /// Whether sending can work right now (relay paired and reachable).
    var isReady: Bool { get }
    /// Why sending is unavailable right now (shown instead of a send button).
    var unavailableReason: String { get }
    /// Re-checks readiness. Called by the adapter on every poll, before it maps
    /// sessions, so `isReady` is never older than one poll.
    func refresh() async
    func send(workspaceId: String, sessionId: String, text: String) async -> SendResult
}

public extension ConductorSender {
    var unavailableReason: String { "Squeak's relay is not set up yet" }
    func refresh() async {}
}

/// The default sender before the relay is set up: never sends.
public struct NullSender: ConductorSender {
    public init() {}
    public var isReady: Bool { false }
    public func send(workspaceId: String, sessionId: String, text: String) async -> SendResult {
        .notSent(reason: "relay not set up")
    }
}

/// Step 2 adapter: reads Conductor's own database and the agents' transcripts
/// directly, with no Node daemon. Conductor chats only. Read-only; sending goes
/// through the injected `ConductorSender`.
public struct ConductorLocalAdapter: HostAdapter {
    public let id = "conductor-local"
    public static let sessionLimit = 100

    private let registry: ConductorRegistry
    private let activityReader: ClaudeActivityReader
    private let sender: any ConductorSender
    private let now: @Sendable () -> Date
    private let activeOnly: Bool

    /// - Parameter activeOnly: when true, `discover` returns only sessions the
    ///   active rule keeps on screen (working, blocked, finished/error in the
    ///   last 15 minutes). Default false: every non-closed chat, newest first.
    public init(
        database: ConductorDatabase = ConductorDatabase(),
        activityReader: ClaudeActivityReader = ClaudeActivityReader(),
        sender: any ConductorSender = NullSender(),
        activeOnly: Bool = false,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.registry = ConductorRegistry(database: database)
        self.activityReader = activityReader
        self.sender = sender
        self.activeOnly = activeOnly
        self.now = now
    }

    // MARK: Mapping

    static func sessionLabel(_ s: HostSession) -> String {
        if let repo = s.repoName, let branch = s.branch, branch != "HEAD", !repo.isEmpty { return "\(repo) · \(branch)" }
        if let cwd = s.cwd, !cwd.isEmpty { return cwd }
        if let repo = s.repoName, !repo.isEmpty { return repo }
        return s.title.isEmpty ? String(s.key.hostSessionId.prefix(8)) : s.title
    }

    /// Port of `distinctTitles`: a chat's own title is appended only when two
    /// rows share a label. Conductor's "Untitled" placeholder counts as none.
    static func applyDistinctTitles(_ sessions: [HostSession]) -> [HostSession] {
        var counts: [String: Int] = [:]
        for s in sessions { counts[sessionLabel(s), default: 0] += 1 }
        return sessions.map { s in
            var s = s
            guard counts[sessionLabel(s)] ?? 0 > 1 else { return s }
            let title = s.title.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty, title != "Untitled" else { return s }
            s.distinctTitle = title.count > 34 ? String(title.prefix(33)).trimmingCharacters(in: .whitespaces) + "…" : title
            return s
        }
    }

    func map(_ row: ConductorSessionRow, now: Date) -> (session: HostSession, retired: Bool) {
        let state = ConductorStatus.state(of: row, now: now)
        let retired = ConductorStatus.isRetired(row)
        let sendCapability: Capability
        if retired {
            sendCapability = .unsupported("This chat is closed or its workspace is archived")
        } else if sender.isReady {
            sendCapability = .supported
        } else {
            sendCapability = .unsupported(sender.unavailableReason)
        }
        let session = HostSession(
            key: SessionKey(provider: "conductor", workspaceId: row.workspaceId, hostSessionId: row.id),
            title: row.title ?? "",
            repoName: row.repositoryName.flatMap { $0.isEmpty ? nil : $0 },
            branch: (row.branch ?? row.directoryName).flatMap { $0.isEmpty ? nil : $0 },
            cwd: row.workspacePath.flatMap { $0.isEmpty ? nil : $0 },
            agent: row.agentType == "codex" ? "codex" : "claude",
            state: state,
            lastActivityAt: ConductorStatus.activityTime(of: row, state: state),
            alive: nil,
            replyTarget: row.id,
            conductorWorkspaceId: row.workspaceId,
            conductorSessionId: row.id,
            capabilities: Capabilities(
                discover: .supported, readTranscript: .supported, send: sendCapability, activity: .supported,
                approve: .unsupported("Approve in Conductor"), openInHost: .supported,
                attachments: .unsupported("Attachments are not supported yet")),
            origin: .hostOwned,
            pendingQuestion: state == .blocked ? row.pendingQuestion : nil)
        return (session, retired)
    }

    // MARK: HostAdapter

    public func discover() async throws -> [HostSession] {
        await sender.refresh()
        let current = now()
        let rows = try registry.listFleetSessions(limit: Self.sessionLimit)
        var sessions: [HostSession] = []
        for row in rows where !row.isHidden {
            let (session, retired) = map(row, now: current)
            if activeOnly,
               !ConductorStatus.isActive(state: session.state, retired: retired, lastActivityAt: session.lastActivityAt, now: current)
            { continue }
            sessions.append(session)
        }
        return Self.applyDistinctTitles(sessions)
    }

    public func transcript(for session: HostSession, limit: Int) async throws -> [ChatMessage] {
        try registry.transcript(sessionId: sessionId(of: session), limit: limit).messages
    }

    public func activity(for session: HostSession) async throws -> [ActivityStep] {
        let id = sessionId(of: session)
        let rows = try registry.database.query(
            "SELECT agent_type as agentType, claude_session_id as claudeSessionId FROM sessions WHERE id = ?", [.text(id)])
        guard let row = rows.first else { return [] }
        return activityReader.activity(agentType: row["agentType"]?.string, agentSessionId: row["claudeSessionId"]?.string).steps
    }

    public func send(_ text: String, to session: HostSession, clientId: UUID) async -> SendResult {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .notSent(reason: "Nothing to send") }
        guard let workspace = session.conductorWorkspaceId else { return .notSent(reason: "This chat has no Conductor workspace") }
        guard sender.isReady else { return .notSent(reason: sender.unavailableReason) }
        return await sender.send(workspaceId: workspace, sessionId: sessionId(of: session), text: text)
    }

    public func openInHostURL(for session: HostSession) -> URL? {
        guard session.key.provider == "conductor", let ws = session.conductorWorkspaceId else { return nil }
        var c = URLComponents()
        c.scheme = "conductor"
        c.host = "workspace"
        c.queryItems = [URLQueryItem(name: "id", value: ws), URLQueryItem(name: "session", value: sessionId(of: session))]
        return c.url
    }

    public func health() async -> AdapterHealth {
        let db = registry.database
        guard db.exists else {
            return AdapterHealth(adapterId: id, status: .degraded("Conductor's database was not found"))
        }
        do {
            _ = try db.query("SELECT 1 FROM sessions LIMIT 1")
            return AdapterHealth(adapterId: id, status: .connected, lastSyncedAt: now())
        } catch {
            return AdapterHealth(adapterId: id, status: .degraded("Conductor's database could not be read"))
        }
    }

    private func sessionId(of session: HostSession) -> String {
        session.conductorSessionId ?? session.key.hostSessionId
    }
}
