import CryptoKit
import Foundation

/// Every session the daemon sees (terminal, desktop, headless, and any add-on's host), through the daemon.
public struct DaemonAdapter: HostAdapter {
    /// How an add-on's host app opens one of its chats: provider, workspace id, session id, then the URL.
    public typealias HostOpener = @Sendable (_ provider: String, _ workspaceId: String?, _ sessionId: String?) -> URL?

    public let id = "daemon"
    private let client: DaemonClient
    private let now: @Sendable () -> Date
    private let excluded: Set<String>
    private let opener: HostOpener?

    /// - Parameters:
    ///   - excluding: providers an add-on's own adapter serves; the daemon's rows for them are dropped so no chat
    ///     appears twice and no such key comes from here.
    ///   - opener: an add-on host's way to open a chat in its own app; nil: no chat can be opened from here.
    public init(
        client: DaemonClient, excluding: Set<String> = [], opener: HostOpener? = nil,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.client = client
        self.excluded = excluding
        self.opener = opener
        self.now = now
    }

    // MARK: Mapping

    /// A host app's own chats keep the host's name (the wire's `conductor`); otherwise `<agent>-<origin>`
    /// (claude-terminal, codex-terminal, claude-desktop, claude-sdk ...).
    static func provider(origin: String?, agent: String?) -> String {
        let o = (origin?.isEmpty == false) ? origin! : "unknown"
        if o == "conductor" { return "conductor" }
        let a = (agent?.isEmpty == false) ? agent! : "agent"
        return "\(a)-\(o)"
    }

    static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s
    }

    static func map(_ d: DaemonSession, opensInHost: Bool = false) -> HostSession {
        let provider = provider(origin: d.origin, agent: d.agent)
        // A chat Squeak runs itself is not a Conductor chat even when the daemon joined it to the Conductor row it
        // was imported from: those ids would key it apart from `NativeAdapter`'s row (a duplicate under the same
        // project) and mark it with Conductor's badge while no Conductor workspace is picked.
        let isNative = d.origin == "squeak" || d.key.hasPrefix(NativeAdapter.keyPrefix)
        let workspace = isNative ? nil : nonEmpty(d.conductorWorkspaceId)
        let conductorSession = isNative ? nil : (nonEmpty(d.conductorSessionId) ?? (provider == "conductor" ? nonEmpty(d.replyTarget) : nil))
        let replyTarget = nonEmpty(d.replyTarget)
        var caps = Capabilities(
            discover: .supported,
            readTranscript: .supported,
            send: replyTarget == nil ? .unsupported("Squeak has no way to reply to this session") : .supported,
            activity: .supported,
            approve: .unsupported("Approve in the host app"),
            openInHost: .unsupported("This session cannot be opened from Squeak"),
            attachments: replyTarget != nil && nonEmpty(d.cwd) != nil
                ? .supported : .unsupported("Squeak doesn't know this chat's folder, so it can't save an image there")
        )
        if opensInHost, provider == "conductor", workspace != nil, conductorSession != nil { caps.openInHost = .supported }
        // A finished chat that ends on a question is waiting on you: it reads as blocked, carrying the question,
        // so every surface (grouping, the menu bar count, the banner) treats it as needing you. It stays
        // replyable: a finished chat is idle.
        let state = SessionState(daemon: d.state)
        let ask = state == .finished ? d.asks : nil
        return HostSession(
            key: SessionKey(provider: provider, workspaceId: workspace, hostSessionId: d.key),
            title: d.title ?? "",
            distinctTitle: nonEmpty(d.distinctTitle),
            repoName: nonEmpty(d.repoName),
            branch: nonEmpty(d.branch),
            cwd: nonEmpty(d.cwd),
            agent: nonEmpty(d.agent),
            state: ask == nil ? state : .blocked,
            lastActivityAt: d.lastActivityAt,
            alive: d.alive,
            replyTarget: replyTarget,
            conductorWorkspaceId: workspace,
            conductorSessionId: conductorSession,
            capabilities: caps,
            // A native chat (origin "squeak") is Squeak's own: its provider is `<agent>-squeak`.
            origin: d.origin == "squeak" ? .squeakManaged : .hostOwned,
            awaitingApproval: d.state == "awaiting_approval" ? true : nil,
            pendingQuestion: ask,
            contextPercent: d.contextPercent,
            workspaceName: nil,
            backgroundWaiting: d.conductorWaiting,
            ducklings: d.ducklings,
            looping: d.state == "working" ? d.looping : nil,
            archivedAt: d.archivedAt
        )
    }

    /// What a history read addresses: the reply target, else the session's own fleet key. A session Squeak only
    /// watches (a terminal agent it cannot type into) has no reply target, but the daemon reads its transcript
    /// file by key; without this the window showed only the current turn's steps.
    static func historyTarget(_ session: HostSession) -> String {
        session.replyTarget ?? session.key.hostSessionId
    }

    // MARK: HostAdapter

    public func discover() async throws -> [HostSession] {
        let opens = opener != nil
        let all = try await client.state().sessions.map { Self.map($0, opensInHost: opens) }
        return excluded.isEmpty ? all : all.filter { !excluded.contains($0.key.provider) }
    }

    public func transcript(for session: HostSession, limit: Int) async throws -> [ChatMessage] {
        let target = Self.historyTarget(session)
        if let t = try await client.transcript(replyTarget: target, limit: limit, before: nil) {
            return t.messages.compactMap { m in
                guard let role = MessageRole(rawValue: m.role) else { return nil }
                return ChatMessage(id: m.id, role: role, text: m.text, at: m.at, turnId: m.turnId, cursor: m.cursor)
            }
        }
        // Older daemon: only the last assistant turn is available.
        guard let last = try await client.lastMessage(replyTarget: target), !last.text.isEmpty else { return [] }
        let digest = SHA256.hash(data: Data(last.text.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
        return [ChatMessage(id: "last-\(digest)", role: .assistant, text: last.text, at: nil, turnId: nil)]
    }

    public func transcriptPage(for session: HostSession, limit: Int, before: String?) async throws -> TranscriptPage {
        let target = Self.historyTarget(session)
        guard let t = try await client.transcript(replyTarget: target, limit: limit, before: before) else {
            // Older daemon: no paging, only the last turn.
            guard before == nil else { return TranscriptPage(messages: [], nextBefore: nil) }
            return TranscriptPage(messages: try await transcript(for: session, limit: limit), nextBefore: nil)
        }
        let messages = t.messages.compactMap { m -> ChatMessage? in
            guard let role = MessageRole(rawValue: m.role) else { return nil }
            return ChatMessage(id: m.id, role: role, text: m.text, at: m.at, turnId: m.turnId, cursor: m.cursor)
        }
        // A daemon that predates paging says `complete` and no cursor: nothing more to load unless it says so.
        return TranscriptPage(messages: messages, nextBefore: t.complete ? nil : t.nextBefore)
    }

    public func activity(for session: HostSession) async throws -> [ActivityStep] {
        try await client.activity(sessionKey: session.key.hostSessionId).steps.map {
            ActivityStep(kind: $0.kind, text: $0.text, at: $0.at)
        }
    }

    public func send(_ text: String, to session: HostSession, clientId: UUID) async -> SendResult {
        await send(text, to: session, clientId: clientId, mode: .queue)
    }

    public func send(_ text: String, to session: HostSession, clientId: UUID, mode: SendMode) async -> SendResult {
        await send(text, to: session, clientId: clientId, mode: mode, answersTurn: nil)
    }

    public func send(_ text: String, to session: HostSession, clientId: UUID, mode: SendMode, answersTurn: String?) async -> SendResult {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .notSent(reason: "Nothing to send") }
        guard let target = session.replyTarget else { return .notSent(reason: "Squeak has no way to reply to this session") }
        return await client.reply(replyTarget: target, text: text, mode: mode, answersTurn: answersTurn)
    }

    public func openInHostURL(for session: HostSession) -> URL? {
        opener?(session.key.provider, session.conductorWorkspaceId, session.conductorSessionId)
    }

    public func health() async -> AdapterHealth {
        do {
            _ = try await client.state()
            return AdapterHealth(adapterId: id, status: client.hasToken ? .connected : .tokenMissing)
        } catch AdapterError.daemonDown {
            return AdapterHealth(adapterId: id, status: .daemonDown)
        } catch {
            return AdapterHealth(adapterId: id, status: .degraded("\(error)"))
        }
    }
}
