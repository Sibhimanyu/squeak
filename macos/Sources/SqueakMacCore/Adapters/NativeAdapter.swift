import Foundation

/// What only a chat Squeak runs itself can do, beside what every `HostAdapter` does. The UI asks the broker's
/// adapter for this protocol and offers a control only when it answers (Conductor and terminal chats do not).
public protocol NativeChatControls: Sendable {
    /// What the host knows about the chat that `HostSession` does not carry: model, effort, permission mode, status.
    func info(for session: HostSession) async throws -> NativeSession
    func interrupt(_ session: HostSession) async -> NativeActionResult
    /// Compacts the chat's context through the host; `.refused` while it works, `.failed` from a host that lacks the route.
    func compact(_ session: HostSession) async -> NativeActionResult
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
    func setModel(_ session: HostSession, model: String, effort: String?, split: WorkSplit?) async -> NativeActionResult
    /// Renames the chat (already checked by `ThreadTitle`); the host refuses text it will not store.
    func rename(_ session: HostSession, to title: String) async -> NativeActionResult
    /// Archives or unarchives the chat (`ThreadArchive` decides when the menu offers it; the host refuses a busy chat).
    func archive(_ session: HostSession, archived: Bool) async -> NativeActionResult
    func queue(for session: HostSession) async throws -> [NativeQueueItem]
    func removeQueued(_ session: HostSession, queueId: String) async -> NativeActionResult
    func editQueued(_ session: HostSession, queueId: String, text: String) async -> NativeActionResult
    /// Holds a queued message while it is edited (nothing is sent meanwhile) or releases it, saving `text` when given.
    func holdQueued(_ session: HostSession, queueId: String, held: Bool, text: String?) async -> NativeActionResult
    /// The queue stack's items (queued and steering); an older host's plain queue stands in as all-queued.
    func pending(for session: HostSession) async throws -> [NativePendingItem]
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
    /// The newest rows read per chat, so a refresh asks the host only for rows after the last seq held.
    public let rowCache = NativeRowCache()
    let nameCache = NativeNameCache()

    /// Forgets a chat's held rows (the chat was opened afresh, or the host said its rows were reset).
    public func invalidateRows(hostId: String) { rowCache.invalidate(hostId) }

    /// The held rows brought up to the host's newest by asking for only what is after them; nil when nothing is held.
    private func caughtUpRows(_ id: String) async throws -> (rows: [NativeMessage], exhausted: Bool)? {
        guard let held = rowCache.get(id), let last = held.rows.last else { return nil }
        var rows = held.rows
        var after = last.seq
        while true {
            let got = try await call { try await host.messages(id: id, after: after, limit: 500) }
            if got.isEmpty { break }
            rows += got
            after = got.last!.seq
            if got.count < 500 { break }
        }
        rowCache.put(id, rows: rows, exhausted: held.exhausted)
        return rowCache.get(id)
    }

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
        switch NativeStatus.normalized(status) {
        case "working", "stopping", "waiting": .working
        case "awaiting_approval", "awaiting_plan", "awaiting_answer": .blocked
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
            title: DaemonAdapter.nonEmpty(s.title) ?? d?.title ?? "",
            distinctTitle: DaemonAdapter.nonEmpty(d?.distinctTitle),
            repoName: DaemonAdapter.nonEmpty(d?.repoName) ?? folder,
            branch: DaemonAdapter.nonEmpty(d?.branch),
            cwd: DaemonAdapter.nonEmpty(s.cwd),
            agent: s.agent,
            state: ask == nil ? state : .blocked,
            lastActivityAt: s.updatedAt,
            alive: nil,
            replyTarget: target,
            conductorWorkspaceId: nil,
            conductorSessionId: nil,
            capabilities: caps,
            origin: .squeakManaged,
            awaitingApproval: NativeStatus.isAwaitingApproval(s.status) ? true : nil,
            pendingQuestion: ask,
            contextPercent: ContextFormat.percent(tokens: s.contextTokens, limit: s.contextLimit) ?? d?.contextPercent,
            workspaceName: DaemonAdapter.nonEmpty(workspaceName) ?? folder,
            backgroundWaiting: s.status == "waiting" ? true : nil,
            workspaceTitle: DaemonAdapter.nonEmpty(workspaceTitle),
            backgroundCount: s.backgroundCount,
            contextTokens: s.contextTokens, contextLimit: s.contextLimit, ducklings: s.ducklings,
            archivedAt: s.archivedAt
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

    /// The host's workspace names by id (best effort: a failure leaves the folder's name). A name rarely changes, so
    /// the projects-then-workspaces walk (one request per project) runs only for an id not seen yet or once a minute.
    private func workspaceNames(for sessions: [NativeSession]) async -> [String: (name: String, title: String?)] {
        let wanted = Set(sessions.compactMap(\.workspaceId))
        guard !wanted.isEmpty else { return [:] }
        if let held = nameCache.fresh(covering: wanted) { return held }
        guard let projects = try? await host.projects() else { return nameCache.all() }
        var names: [String: (name: String, title: String?)] = [:]
        for p in projects {
            for w in (try? await host.workspaces(projectId: p.id)) ?? [] { names[w.id] = (w.name, w.title) }
        }
        nameCache.put(names)
        return names
    }

    public func transcript(for session: HostSession, limit: Int) async throws -> [ChatMessage] {
        try await transcriptPage(for: session, limit: limit, before: nil).messages
    }

    /// Pages by the host's row seq: each chat message is one row (a text block), so a message's cursor is exact. A page
    /// always starts at a person's message, so a turn (its steps between the two messages) is never split across pages.
    public func transcriptPage(for session: HostSession, limit: Int, before: String?) async throws -> TranscriptPage {
        guard let id = Self.nativeId(session) else { return TranscriptPage(messages: [], nextBefore: nil) }
        if before == nil, let held = try await caughtUpRows(id) {
            let mapped = NativeTranscript.map(held.rows)
            if let start = Self.pageStart(mapped.messages, limit: limit, exhausted: held.exhausted) {
                return Self.page(mapped, from: start, exhausted: held.exhausted, cursor: nil)
            }
        }
        let chunk = 400
        var cursor: Int? = before.flatMap { Int($0) }
        var rows: [NativeMessage] = []
        var exhausted = false
        var mapped = NativeTranscript.Mapped()
        var start: Int?
        var rounds = 0
        repeat {
            let got = try await call { try await host.messages(id: id, before: cursor, limit: chunk) }
            rounds += 1
            rows = got + rows
            if let first = got.first { cursor = first.seq }
            if got.count < chunk { exhausted = true }
            mapped = NativeTranscript.map(rows)
            start = Self.pageStart(mapped.messages, limit: limit, exhausted: exhausted)
        } while start == nil && !exhausted && rounds < 10
        if before == nil { rowCache.put(id, rows: rows, exhausted: exhausted) }
        return Self.page(mapped, from: start ?? max(0, mapped.messages.count - limit), exhausted: exhausted, cursor: cursor)
    }

    /// Where a page of about `limit` messages starts in `chat`: moved back to the person's message that opened its
    /// first turn. Nil when the rows read cannot say yet (too few messages, or the turn's opening is further back).
    static func pageStart(_ chat: [ChatMessage], limit: Int, exhausted: Bool) -> Int? {
        guard exhausted || chat.count > limit else { return nil }
        var i = max(0, chat.count - limit)
        while i > 0, i < chat.count, !NativeTranscript.startsTurn(chat[i]) { i -= 1 }
        if !exhausted, chat.isEmpty || !NativeTranscript.startsTurn(chat[i]) { return nil }
        return i
    }

    /// The page from `start` on, with its turns' steps and the cursor for what precedes it.
    static func page(_ mapped: NativeTranscript.Mapped, from start: Int, exhausted: Bool, cursor: Int?) -> TranscriptPage {
        let messages = Array(mapped.messages[min(start, mapped.messages.count)...])
        var turns: [String: [ActivityStep]] = [:]
        for t in Set(messages.compactMap(\.turnId)) { if let steps = mapped.turnSteps[t] { turns[t] = steps } }
        let next: String? = start == 0 && exhausted ? nil : (messages.first?.cursor ?? cursor.map(String.init))
        return TranscriptPage(messages: messages, nextBefore: next, turns: turns)
    }

    public func activity(for session: HostSession) async throws -> [ActivityStep] {
        try await activityFeed(for: session).steps
    }

    public func activityFeed(for session: HostSession) async throws -> NativeActivityFeed {
        guard let id = Self.nativeId(session) else { return NativeActivityFeed(steps: [], details: [:]) }
        var rows: [NativeMessage] = []
        var cursor: Int?
        if let held = try await caughtUpRows(id), NativeTranscript.currentTurn(held.rows) != nil { rows = held.rows } else {
        // The turn is the rows from the person's newest message; widen the window until it holds that message.
        for _ in 0..<4 {
            let got = try await call { try await host.messages(id: id, before: cursor, limit: 400) }
            rows = got + rows
            if NativeTranscript.currentTurn(rows) != nil || got.count < 400 { break }
            cursor = got.first?.seq
        }
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

    public func compact(_ session: HostSession) async -> NativeActionResult {
        await act(session) { id in try await host.compact(id: id) }
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

    public func rename(_ session: HostSession, to title: String) async -> NativeActionResult {
        await act(session) { id in try await host.renameSession(id: id, title: title) }
    }

    public func archive(_ session: HostSession, archived: Bool) async -> NativeActionResult {
        await act(session) { id in try await host.archiveSession(id: id, archived: archived) }
    }

    public func setModel(_ session: HostSession, model: String, effort: String?, split: WorkSplit? = nil) async -> NativeActionResult {
        await act(session) { id in try await host.setModel(id: id, model: model, effort: effort, split: split) }
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

    public func holdQueued(_ session: HostSession, queueId: String, held: Bool, text: String?) async -> NativeActionResult {
        await act(session) { id in try await host.holdQueued(id: id, queueId: queueId, held: held, text: text) }
    }

    public func pending(for session: HostSession) async throws -> [NativePendingItem] {
        guard let id = Self.nativeId(session) else { return [] }
        do { return try await call { try await host.pending(id: id) } }
        catch AdapterError.http(404) { return try await queue(for: session).map(NativePendingItem.init) }
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

/// Rows held per chat (the newest contiguous tail). Append-only: the host's rows after a seq never change.
public final class NativeRowCache: @unchecked Sendable {
    public static let maxRows = 4000
    private let lock = NSLock()
    private var store: [String: (rows: [NativeMessage], exhausted: Bool)] = [:]
    public init() {}

    public func get(_ id: String) -> (rows: [NativeMessage], exhausted: Bool)? {
        lock.lock(); defer { lock.unlock() }
        return store[id]
    }

    public func put(_ id: String, rows: [NativeMessage], exhausted: Bool) {
        lock.lock(); defer { lock.unlock() }
        if rows.count > Self.maxRows { store[id] = (Array(rows.suffix(Self.maxRows)), false) } else { store[id] = (rows, exhausted) }
    }

    public func invalidate(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        store[id] = nil
    }
}

/// Workspace names by id, reused until an unknown id turns up or `maxAge` passes.
public final class NativeNameCache: @unchecked Sendable {
    private let lock = NSLock()
    private let maxAge: TimeInterval
    private let now: @Sendable () -> Date
    private var names: [String: (name: String, title: String?)] = [:]
    private var at: Date?
    public init(maxAge: TimeInterval = 60, now: @escaping @Sendable () -> Date = { Date() }) {
        self.maxAge = maxAge
        self.now = now
    }

    public func fresh(covering ids: Set<String>) -> [String: (name: String, title: String?)]? {
        lock.withLock {
            guard let at, now().timeIntervalSince(at) < maxAge, ids.allSatisfy({ names[$0] != nil }) else { return nil }
            return names
        }
    }

    public func all() -> [String: (name: String, title: String?)] { lock.withLock { names } }

    public func put(_ new: [String: (name: String, title: String?)]) {
        lock.withLock { names = new; at = now() }
    }
}
