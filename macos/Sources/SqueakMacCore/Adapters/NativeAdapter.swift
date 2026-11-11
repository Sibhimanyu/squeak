import Foundation

/// What only a chat Squeak runs itself can do, beside what every `HostAdapter` does. The UI asks the broker's
/// adapter for this protocol and offers a control only when it answers (Conductor and terminal chats do not).
public protocol NativeChatControls: Sendable {
    /// What the host knows about the chat that `HostSession` does not carry: model, effort, permission mode, status.
    func info(for session: HostSession) async throws -> NativeSession
    func interrupt(_ session: HostSession) async -> NativeActionResult
    /// Answers an open request: allow or deny, with the person's words (a deny's reason, "tell it what to do instead")
    /// and, for an AskUserQuestion, the chosen answers.
    func respond(requestId: String, allow: Bool, message: String?, answers: NativeJSON?) async -> NativeActionResult
    /// Allows a tool approval and keeps an allow rule for the chat. An older host refuses with a fixed sentence.
    func allowForSession(requestId: String) async -> NativeActionResult
    /// Allows an Edit/Write approval and every edit for the rest of the chat. `.refused` from a host that lacks it.
    func allowEditsForChat(requestId: String) async -> NativeActionResult
    /// Has the host get the chat's agent ready (the chat was opened). Never fails visibly; an older host ignores it.
    func warm(_ session: HostSession) async
    /// The chat's allow rules; nil when this host has no rules route (the section stays hidden).
    func rules(for session: HostSession) async throws -> [NativeRule]?
    func removeRule(_ session: HostSession, ruleId: String) async -> NativeActionResult
    /// `default`, `acceptEdits`, `plan`, `bypassPermissions`.
    func setMode(_ session: HostSession, to mode: String) async -> NativeActionResult
    func setModel(_ session: HostSession, model: String, effort: String?) async -> NativeActionResult
    func queue(for session: HostSession) async throws -> [NativeQueueItem]
    func removeQueued(_ session: HostSession, queueId: String) async -> NativeActionResult
    func editQueued(_ session: HostSession, queueId: String, text: String) async -> NativeActionResult
    /// Codex steers the running turn; Claude answers refused "can't steer" and the queue keeps the message.
    func steerQueued(_ session: HostSession, queueId: String) async -> NativeActionResult
    /// Open requests with the full payload (tool name and input, plan text, question and options).
    func openRequests(for session: HostSession) async throws -> [NativeRequest]
    /// The current turn's steps with the output and diffs that open under their rows.
    func activityFeed(for session: HostSession) async throws -> NativeActivityFeed
    /// Live events from the newest seq the caller holds; reconnects itself.
    func events(for session: HostSession, after: Int) -> AsyncStream<NativeEvent>
}

public struct NativeActivityFeed: Sendable, Equatable {
    public var steps: [ActivityStep]
    public var details: [String: ToolDetail]
}

/// Squeak's own chats, served by the session host.
///
/// **Source of truth for discovery: the host's session list.** It alone knows a chat exists, its status (including
/// which kind of request it waits on), model and mode, and it answers with the daemon down. The daemon's `/state`
/// is only an overlay for display fields the host does not compute (disambiguated title, repo, branch, context
/// percent, a finished chat's closing question). Keys match the daemon adapter's for the same chat
/// (`<agent>-squeak`, `squeak-native:<id>`), so the broker never lists one twice. With the host not running this
/// adapter finds nothing and says nothing; the daemon adapter's rows (read from `native.db`) carry on, read-only.
public struct NativeAdapter: HostAdapter, NativeChatControls {
    public let id = "squeak-native"
    public static let keyPrefix = "squeak-native:"

    private let host: NativeHostClient
    private let daemon: DaemonClient?

    public init(host: NativeHostClient, daemon: DaemonClient? = nil) {
        self.host = host
        self.daemon = daemon
    }

    // MARK: Mapping

    static func hostSessionId(_ nativeId: String) -> String { keyPrefix + nativeId }

    public static func nativeId(_ session: HostSession) -> String? {
        let id = session.key.hostSessionId
        guard id.hasPrefix(keyPrefix), id.count > keyPrefix.count else { return nil }
        return String(id.dropFirst(keyPrefix.count))
    }

    static func state(for status: String, lastTurnEndedAt: Date?) -> SessionState {
        switch status {
        case "working", "cancelling", "waiting": .working
        case "needs_user_permission", "needs_plan_response", "needs_user_input": .blocked
        case "error": .error
        default: lastTurnEndedAt == nil ? .idle : .finished
        }
    }

    static func map(_ s: NativeSession, overlay d: DaemonSession?, workspaceName: String? = nil, workspaceTitle: String? = nil) -> HostSession {
        let target = hostSessionId(s.id)
        let folder = s.cwd.split(separator: "/").last.map(String.init)
        let state = state(for: s.status, lastTurnEndedAt: s.lastTurnEndedAt)
        let ask = state == .finished ? d?.asks : nil
        let caps = Capabilities(
            discover: .supported, readTranscript: .supported, send: .supported, activity: .supported, approve: .supported,
            openInHost: .unsupported("This chat is Squeak's own"),
            attachments: s.cwd.isEmpty ? .unsupported("Squeak doesn't know this chat's folder, so it can't save an image there") : .supported)
        return HostSession(
            key: SessionKey(provider: "\(s.agent)-squeak", workspaceId: nil, hostSessionId: target),
            title: ConductorDaemonAdapter.nonEmpty(s.title) ?? d?.title ?? "",
            distinctTitle: ConductorDaemonAdapter.nonEmpty(d?.distinctTitle),
            repoName: ConductorDaemonAdapter.nonEmpty(d?.repoName) ?? folder,
            branch: ConductorDaemonAdapter.nonEmpty(d?.branch),
            cwd: ConductorDaemonAdapter.nonEmpty(s.cwd),
            agent: s.agent,
            state: ask == nil ? state : .blocked,
            lastActivityAt: s.updatedAt,
            alive: nil,
            replyTarget: target,
            conductorWorkspaceId: nil,
            conductorSessionId: nil,
            capabilities: caps,
            origin: .squeakManaged,
            awaitingApproval: s.status == "needs_user_permission" ? true : nil,
            pendingQuestion: ask,
            contextPercent: d?.contextPercent,
            workspaceName: ConductorDaemonAdapter.nonEmpty(workspaceName) ?? folder,
            backgroundWaiting: s.status == "waiting" ? true : nil,
            workspaceTitle: ConductorDaemonAdapter.nonEmpty(workspaceTitle),
            backgroundCount: s.backgroundCount
        )
    }

    /// The row for a chat the host just created, before the list shows it.
    public static func started(_ s: NativeSession) -> HostSession { map(s, overlay: nil) }

    // MARK: HostAdapter

    public func discover() async throws -> [HostSession] {
        let sessions: [NativeSession]
        do { sessions = try await host.sessions() }
        catch NativeHostError.hostDown { return [] }
        catch let e as NativeHostError { throw e.adapterError }
        var overlay: [String: DaemonSession] = [:]
        if let daemon, let state = try? await daemon.state() {
            for d in state.sessions where d.key.hasPrefix(Self.keyPrefix) { overlay[d.key] = d }
        }
        let names = await workspaceNames(for: sessions)
        return sessions.map { Self.map($0, overlay: overlay[Self.hostSessionId($0.id)], workspaceName: $0.workspaceId.flatMap { names[$0]?.name }, workspaceTitle: $0.workspaceId.flatMap { names[$0]?.title }) }
    }

    /// The host's workspace names by id (best effort: a failure leaves the folder's name).
    private func workspaceNames(for sessions: [NativeSession]) async -> [String: (name: String, title: String?)] {
        guard sessions.contains(where: { $0.workspaceId != nil }), let projects = try? await host.projects() else { return [:] }
        var names: [String: (name: String, title: String?)] = [:]
        for p in projects {
            for w in (try? await host.workspaces(projectId: p.id)) ?? [] { names[w.id] = (w.name, w.title) }
        }
        return names
    }

    public func transcript(for session: HostSession, limit: Int) async throws -> [ChatMessage] {
        try await transcriptPage(for: session, limit: limit, before: nil).messages
    }

    /// Pages by the host's row seq: each chat message is one row (a text block), so a message's cursor is exact.
    public func transcriptPage(for session: HostSession, limit: Int, before: String?) async throws -> TranscriptPage {
        guard let id = Self.nativeId(session) else { return TranscriptPage(messages: [], nextBefore: nil) }
        let chunk = 400
        var cursor: Int? = before.flatMap { Int($0) }
        var rows: [NativeMessage] = []
        var exhausted = false
        var chat: [ChatMessage] = []
        var rounds = 0
        repeat {
            let got = try await call { try await host.messages(id: id, before: cursor, limit: chunk) }
            rounds += 1
            rows = got + rows
            if let first = got.first { cursor = first.seq }
            if got.count < chunk { exhausted = true }
            chat = NativeTranscript.map(rows).messages
        } while chat.count <= limit && !exhausted && rounds < 10
        if chat.count > limit {
            let page = Array(chat.suffix(limit))
            return TranscriptPage(messages: page, nextBefore: page.first?.cursor)
        }
        return TranscriptPage(messages: chat, nextBefore: exhausted ? nil : cursor.map(String.init))
    }

    public func activity(for session: HostSession) async throws -> [ActivityStep] {
        try await activityFeed(for: session).steps
    }

    public func activityFeed(for session: HostSession) async throws -> NativeActivityFeed {
        guard let id = Self.nativeId(session) else { return NativeActivityFeed(steps: [], details: [:]) }
        var rows: [NativeMessage] = []
        var cursor: Int?
        // The turn is the rows from the person's newest message; widen the window until it holds that message.
        for _ in 0..<4 {
            let got = try await call { try await host.messages(id: id, before: cursor, limit: 400) }
            rows = got + rows
            if NativeTranscript.currentTurn(rows) != nil || got.count < 400 { break }
            cursor = got.first?.seq
        }
        guard let turn = NativeTranscript.currentTurn(rows) else { return NativeActivityFeed(steps: [], details: [:]) }
        let mapped = NativeTranscript.map(turn)
        // Each step carries what opens under it, so it reaches the transcript through the plain step list.
        let steps = mapped.steps.map { step -> ActivityStep in
            var s = step
            if s.detail == nil, let id = s.toolId { s.detail = mapped.details[id] }
            return s
        }
        return NativeActivityFeed(steps: steps, details: mapped.details)
    }

    public func send(_ text: String, to session: HostSession, clientId: UUID) async -> SendResult {
        await send(text, to: session, clientId: clientId, mode: .queue)
    }

    public func send(_ text: String, to session: HostSession, clientId: UUID, mode: SendMode) async -> SendResult {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .notSent(reason: "Nothing to send") }
        guard let id = Self.nativeId(session) else { return .notSent(reason: "Squeak has no way to reply to this session") }
        do {
            let queued = try await host.send(id: id, text: text, mode: mode)
            // Claude cannot take text mid-turn: steering it queued instead, and the result says so.
            let note = mode == .steer && queued ? "Queued: this chat can't take a message mid-turn." : nil
            return .accepted(via: "native", delivery: queued ? .queued : .sent, note: note)
        } catch let e as NativeHostError {
            switch e {
            case .hostDown, .tokenMissing: return .notSent(reason: e.reason)
            case .tokenRejected: return .notSent(reason: e.reason)
            case .uncertain: return .uncertain(reason: e.reason)
            case .http(let c, _) where c >= 500: return .uncertain(reason: "Squeak's session host failed. Check the chat before sending again.")
            case .http, .badResponse: return .refused(reason: e.reason)
            }
        } catch {
            return .notSent(reason: "Request failed")
        }
    }

    public func openInHostURL(for session: HostSession) -> URL? { nil }

    public func health() async -> AdapterHealth {
        do {
            _ = try await host.sessions()
            return AdapterHealth(adapterId: id, status: host.hasToken ? .connected : .tokenMissing)
        } catch NativeHostError.hostDown {
            return AdapterHealth(adapterId: id, status: .degraded(NativeHostError.hostDown.reason))
        } catch let e as NativeHostError {
            return AdapterHealth(adapterId: id, status: .degraded(e.reason))
        } catch {
            return AdapterHealth(adapterId: id, status: .degraded("Unexpected error"))
        }
    }

    // MARK: NativeChatControls

    public func info(for session: HostSession) async throws -> NativeSession {
        guard let id = Self.nativeId(session) else { throw AdapterError.badResponse("not a native chat") }
        guard let s = try await call({ try await host.session(id: id) }) else { throw AdapterError.http(404) }
        return s
    }

    public func interrupt(_ session: HostSession) async -> NativeActionResult {
        await act(session) { id in try await host.interrupt(id: id) }
    }

    public func respond(requestId: String, allow: Bool, message: String?, answers: NativeJSON?) async -> NativeActionResult {
        await act { try await host.respond(requestId: requestId, allow: allow, message: message, answers: answers) }
    }

    public static let updateHostLine = "Update Squeak's service to allow for the whole chat"

    public func allowForSession(requestId: String) async -> NativeActionResult {
        do {
            try await host.allowForSession(requestId: requestId)
            return .done
        } catch NativeHostError.http(400, _) {
            // A host that does not know `scope` answers 400 (its own validation sentence): say what to do instead.
            return .refused(reason: Self.updateHostLine)
        } catch {
            return await act { throw error }
        }
    }

    public static let editsForChatUnsupported = "This service can't allow edits for the whole chat yet"

    public func allowEditsForChat(requestId: String) async -> NativeActionResult {
        do {
            try await host.allowEditsForChat(requestId: requestId)
            return .done
        } catch NativeHostError.http(let status, _) where status == 400 || status == 404 || status == 422 {
            return .refused(reason: Self.editsForChatUnsupported)
        } catch {
            return await act { throw error }
        }
    }

    public func warm(_ session: HostSession) async {
        guard let id = Self.nativeId(session) else { return }
        await host.warm(id: id)
    }

    public func rules(for session: HostSession) async throws -> [NativeRule]? {
        guard let id = Self.nativeId(session) else { return nil }
        return try await call { try await host.rules(id: id) }
    }

    public func removeRule(_ session: HostSession, ruleId: String) async -> NativeActionResult {
        await act(session) { id in try await host.removeRule(id: id, ruleId: ruleId) }
    }

    public func setMode(_ session: HostSession, to mode: String) async -> NativeActionResult {
        await act(session) { id in try await host.setMode(id: id, permissionMode: mode) }
    }

    public func setModel(_ session: HostSession, model: String, effort: String?) async -> NativeActionResult {
        await act(session) { id in try await host.setModel(id: id, model: model, effort: effort) }
    }

    public func queue(for session: HostSession) async throws -> [NativeQueueItem] {
        guard let id = Self.nativeId(session) else { return [] }
        return try await call { try await host.queue(id: id) }
    }

    public func removeQueued(_ session: HostSession, queueId: String) async -> NativeActionResult {
        await act(session) { id in try await host.removeQueued(id: id, queueId: queueId) }
    }

    public func editQueued(_ session: HostSession, queueId: String, text: String) async -> NativeActionResult {
        await act(session) { id in try await host.editQueued(id: id, queueId: queueId, text: text) }
    }

    public func steerQueued(_ session: HostSession, queueId: String) async -> NativeActionResult {
        await act(session) { id in try await host.steerQueued(id: id, queueId: queueId) }
    }

    public func openRequests(for session: HostSession) async throws -> [NativeRequest] {
        guard let id = Self.nativeId(session) else { return [] }
        return try await call { try await host.openRequests(id: id) }
    }

    public func events(for session: HostSession, after: Int) -> AsyncStream<NativeEvent> {
        guard let id = Self.nativeId(session) else { return AsyncStream { $0.finish() } }
        return host.stream(id: id, after: after)
    }

    // MARK: Plumbing

    private func call<T>(_ body: () async throws -> T) async throws -> T {
        do { return try await body() } catch let e as NativeHostError { throw e.adapterError }
    }

    private func act(_ session: HostSession, _ body: (String) async throws -> Void) async -> NativeActionResult {
        guard let id = Self.nativeId(session) else { return .failed(reason: "This isn't a Squeak chat") }
        return await act { try await body(id) }
    }

    private func act(_ body: () async throws -> Void) async -> NativeActionResult {
        do {
            try await body()
            return .done
        } catch let e as NativeHostError {
            switch e {
            // The host said no in its own sentence: nothing changed.
            case .http(let c, let m) where (400..<500).contains(c): return .refused(reason: m ?? e.reason)
            default: return .failed(reason: e.reason)
            }
        } catch {
            return .failed(reason: "Request failed")
        }
    }
}
