import Foundation
@testable import SqueakMacCore

/// What the Mac's open native chat shows, built from the same model layer the app uses, fed by a `FakeNativeHost`:
/// `NativeHostClient` decoding, `NativeAdapter`, `Broker` (over an encrypted cache and draft store, with an injected
/// clock), `NativeLiveState`, `NativePendingStack`, `OptimisticWork`, `ChatDock`, `TurnFolding`, `NativeTranscript`.
///
/// The event handling mirrors `AppModel.runNativeChat` / `send` / `nativeInterrupt` / `select` line for line (that code
/// is in the executable target, which tests cannot import); every decision it takes goes to a Core type the view reads
/// too. When one of those functions changes shape, change this file with it.
final class ChatScreen: @unchecked Sendable {
    let clock: FakeClock
    let host: FakeNativeHost
    let chatId: String
    let agent: String
    let adapter: NativeAdapter
    let hostClient: NativeHostClient
    let broker: Broker
    let cache: EncryptedCache
    let drafts: DraftStore
    let key: SessionKey

    // What the app holds for the open chat.
    var info: NativeSession?
    var pending = NativePendingStack()
    var live = NativeLiveState()
    var card: NativeCard?
    var optimistic: OptimisticWork?
    var draft = ""
    /// Pictures waiting in the composer (the app's `ImageTray`, per chat; only its count matters here).
    var tray: [String] = []
    var activity: [ActivityStep] = []
    var messages: [ChatMessage] = []
    var turnWork: [String: [ActivityStep]] = [:]
    var catalog: [HostSession] = []
    var lastSeq = 0
    var hostSendsPending = true
    var lastSendResult: SendResult?

    init(host: FakeNativeHost, clock: FakeClock, chatId: String = "c1", agent: String = "claude", cache: EncryptedCache, daemonDown: Bool = false) {
        self.agent = agent
        self.host = host
        self.clock = clock
        self.chatId = chatId
        self.cache = cache
        drafts = DraftStore(cache: cache)
        let client = NativeHostClient(
            baseURL: URL(string: "http://127.0.0.1:8479")!, transport: host, tokenProvider: { "tok" }, sendRetryDelays: [0, 0])
        hostClient = client
        var adapters: [any HostAdapter] = []
        if daemonDown {
            let daemon = DaemonClient(baseURL: URL(string: "http://127.0.0.1:8477")!, transport: DownTransport(), tokenProvider: { "tok" })
            let native = NativeAdapter(host: client, daemon: daemon)
            adapter = native
            adapters = [native, DaemonAdapter(client: daemon)]
        } else {
            adapter = NativeAdapter(host: client)
            adapters = [adapter]
        }
        broker = Broker(adapters: adapters, clock: clock, cache: cache, draftStore: DraftStore(cache: cache))
        key = SessionKey(provider: "\(agent)-squeak", workspaceId: nil, hostSessionId: NativeAdapter.keyPrefix + chatId)
    }

    /// A new app run over the same cache: nothing in memory, the host as it is.
    func relaunched() -> ChatScreen { ChatScreen(host: host, clock: clock, chatId: chatId, agent: agent, cache: cache) }

    // MARK: Opening (mirrors AppModel.select, then runNativeChat up to the stream)

    /// The app starts: the cache is read, the catalog discovered (`AppModel.start`).
    func launch() async {
        await broker.restoreFromCache()
        await broker.refresh()
        catalog = await broker.sessions()
    }

    func open() async {
        draft = await broker.draft(for: key) ?? ""
        await broker.setFocused(key)
        messages = await broker.messages(for: key)
        turnWork = await broker.turns(for: key)
        await broker.refreshTranscript()
        await syncFromBroker()
        // runNativeChat
        adapter.invalidateRows(hostId: chatId)
        info = try? await adapter.info(for: session)
        if let requests = try? await adapter.openRequests(for: session) { card = NativeCards.card(for: requests, agent: "Claude") }
        if let list = try? await adapter.pending(for: session) { pending.apply(.snapshot(list), now: clock.now()) }
        lastSeq = (try? await hostClient.messages(id: chatId, before: nil, limit: 1))?.last?.seq ?? 0
        await refreshActivity()
    }

    /// Leaving the chat saves the draft (`AppModel.select`).
    func leave() async {
        await broker.setDraft(draft, for: key)
        await broker.setFocused(nil)
    }

    var session: HostSession { catalog.first { $0.key == key } ?? NativeAdapter.started(NativeSession(id: chatId)) }

    private func syncFromBroker() async {
        catalog = await applying(await broker.sessions())
        messages = await broker.messages(for: key)
        turnWork = await broker.turns(for: key)
    }

    /// The catalog as the app holds it between refreshes: a status from the stream moves the row at once.
    private var statusOverride: SessionState?
    private func applying(_ list: [HostSession]) async -> [HostSession] {
        guard let statusOverride else { return list }
        return list.map { s in
            var s = s
            if s.key == key { s.state = statusOverride }
            return s
        }
    }

    func refreshActivity() async {
        activity = (try? await broker.activity(for: key)) ?? []
    }

    // MARK: Host events (mirrors the loop body of runNativeChat)

    /// Delivers what the host streamed, in order, then lets the scheduled refresh run.
    func deliver(_ events: NativeEvent...) async {
        for e in events { await apply(e) }
        await settle()
    }

    /// The refresh a burst of events schedules (`scheduleNativeRefresh`) and the nudge it triggers.
    func settle() async {
        clock.advance(0.2)
        await broker.refresh()
        statusOverride = nil
        await broker.refreshTranscript()
        await syncFromBroker()
        await refreshActivity()
    }

    private func apply(_ event: NativeEvent) async {
        if case .message(let m) = event {
            lastSeq = max(lastSeq, m.seq)
            note { $0.observe(message: m.seq, role: m.role == "user" ? .user : .assistant) }
        }
        if case .status(let st) = event {
            if info != nil, info?.status != st { info?.status = st }
            note { $0.observe(status: AppModelMirror.sessionState(st)) }
            statusOverride = AppModelMirror.sessionState(st)
            catalog = await applying(catalog)
        }
        if let change = event.pendingChange {
            hostSendsPending = true
            pending.apply(change, now: clock.now())
        }
        let effect = live.apply(event)
        switch event {
        case .request, .requestResolved, .connected, .reset:
            let next = NativeCards.card(for: live.requests, agent: "Claude")
            if next?.id != card?.id { card = next }
        case .status:
            if let s = try? await adapter.info(for: session) { info = s }
            if let status = live.status {
                if NativeLiveState.needsRequestRefetch(status: status, hasCard: card != nil) {
                    if let list = try? await adapter.openRequests(for: session) { live.replaceRequests(list); card = NativeCards.card(for: list, agent: "Claude") }
                } else if !NativeLiveState.needsRequestRefetch(status: status, hasCard: false) {
                    card = nil
                }
            }
        default: break
        }
        _ = effect
    }

    private func note(_ change: (inout OptimisticWork) -> Void) {
        guard var work = optimistic else { return }
        change(&work)
        optimistic = work.isStarted ? work : nil
    }

    // MARK: The person (mirrors AppModel.send / nativeInterrupt / nativeSteerQueued)

    var liveState: SessionState {
        guard let optimistic else { return session.state }
        return optimistic.resolve(host: session.state, now: clock.now())
    }

    @discardableResult
    func send(_ text: String, mode: SendMode = .queue, answering: Bool = false, clearsDraft requested: Bool = true) async -> SendResult? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let clearsDraft = DraftPolicy.clearsDraft(answering: answering, requested: requested)
        if clearsDraft { draft = "" }
        let turn = answering ? await broker.currentTurnId(for: key) : nil
        let midTurn = liveState == .working
        if !midTurn {
            var work = optimistic?.isStarted == true ? optimistic! : OptimisticWork()
            work.begin(at: clock.now(), baselineSeq: lastSeq, answeringBlocked: session.state == .blocked)
            optimistic = work
        }
        var localCard: String?
        if midTurn {
            localCard = UUID().uuidString
            pending.beginLocal(id: localCard!, text: trimmed, steer: mode == .steer, at: clock.now())
        }
        let result = await broker.send(trimmed, to: key, mode: mode, answersTurn: turn, echoes: localCard == nil, keepsDraft: !clearsDraft)
        lastSendResult = result
        if let localCard {
            switch result {
            case .accepted(_, let delivery, _): pending.settleLocal(id: localCard, accepted: true, queued: delivery == .queued)
            case .uncertain: pending.settleLocal(id: localCard, accepted: true, queued: true)
            case .refused, .notSent: pending.settleLocal(id: localCard, accepted: false, queued: false)
            }
            if case .accepted = result, let list = try? await adapter.pending(for: session) { pending.apply(.snapshot(list), now: clock.now()); pending.prune(now: clock.now()) }
        }
        switch result {
        case .refused, .notSent: if !midTurn { optimistic = nil }
        default: break
        }
        switch result {
        case .refused, .notSent: if localCard == nil, clearsDraft, draft.isEmpty { draft = trimmed }
        default: break
        }
        // What the host streamed because of the send (its row, `working`, a pending item) reaches the Mac's stream.
        for e in host.takeOutbox() { await apply(e) }
        await settle()
        return result
    }

    /// The one-second ticker of `runNativeChat`: a queued send the host never listed does not stay a card.
    func tick(_ seconds: TimeInterval = 1) {
        clock.advance(seconds)
        if pending.hasStale(now: clock.now()) { pending.prune(now: clock.now()) }
    }

    /// A press on the option of an open question card (`nativeAnswer` -> `nativeCardAction`): the host is told, the chat reads
    /// working at once, the card goes.
    func answerCard(option: String) async {
        guard let card else { return }
        let answers = NativeJSON.object(["q0": .string(option)])
        let r = await adapter.respond(requestId: card.id, allow: true, message: nil, answers: answers)
        if case .done = r {
            var work = optimistic?.isStarted == true ? optimistic! : OptimisticWork()
            work.begin(at: clock.now(), baselineSeq: lastSeq, answeringBlocked: true)
            optimistic = work
            self.card = nil
        }
    }

    func stop() async {
        let r = await adapter.interrupt(session)
        if case .done = r { optimistic = nil }
    }

    // MARK: What the person sees

    var dock: ChatDock.Resolved {
        ChatDock.resolve(
            liveState: liveState, messages: shownMessages, awaitingApproval: session.awaitingApproval == true || card?.kind == .approval,
            backgroundCount: session.backgroundCount ?? 0, backgroundWaiting: session.backgroundWaiting == true,
            hostStatus: info?.status, hostBackgroundCount: info?.backgroundCount, optimistic: optimistic?.isStarted == true,
            hostOwnsState: true, hasStopRoute: true, activity: activity, model: nil, now: clock.now())
    }

    /// The transcript without the steers still waiting to be taken in.
    var shownMessages: [ChatMessage] { pending.visible(messages) }

    /// The working row's words; nil when no working row draws, "" when it draws with no words (a chat waiting on you).
    var workingLine: String? { dock.showsRow ? (dock.line ?? "") : nil }

    /// Stop is offered on the working row.
    var stopShown: Bool { dock.showsRow && dock.canStop }

    /// The composer's round button with nothing typed.
    var roundButton: RoundButtonKind {
        ComposerPrompt.button(phase: dock.working ? .working : .idle, hasContent: !draft.isEmpty, canStop: dock.canStop)
    }

    /// The queue stack's cards as the person reads them: the text and the label on the card.
    var cards: [String] {
        pending.cards.map { c in
            switch c.kind {
            case .steering: "\(c.label ?? "Steering…"): \(c.text)"
            case .sending: "Sending: \(c.text)"
            case .queued: "Queued: \(c.text)"
            }
        }
    }

    /// The finished turns' folds, by the message each sits before: "Worked · 3 steps" under that turn's reply.
    var folds: [String: String] {
        let rows = shownMessages
        let found = TurnFolding.folds(
            rows: rows.map { ($0.turnId, $0.role == .assistant) }, newestTurn: rows.reversed().compactMap(\.turnId).first,
            working: dock.isWorking, turnWork: turnWork, activity: activity)
        var out: [String: String] = [:]
        for (i, f) in found {
            let block = TurnFolding.finished(steps: f.steps)
            out[rows[i].id] = TurnFolding.foldedTitle(steps: f.steps, items: block.folded.count) ?? "Worked"
        }
        return out
    }

    /// The live turn's listed steps (the working turn's, newest last), as plain labels.
    var liveSteps: [String] {
        guard dock.isWorking else { return [] }
        let block = TurnFolding.block(steps: activity, working: true)
        return (block.folded + block.shown).map(Self.label)
    }

    /// Every background helper of the live or the given finished turn, with whether it still runs.
    func helpers(inTurnOf messageText: String? = nil) -> [(label: String, running: Bool)] {
        let steps: [ActivityStep]
        if let messageText, let m = messages.first(where: { $0.role == .user && $0.text == messageText }), let t = m.turnId {
            steps = turnWork[t] ?? []
        } else { steps = activity }
        let block = TurnFolding.block(steps: steps, working: false)
        return block.folded.compactMap { item in
            if case .tool(_, let p, let running, let detail) = item, case .subagent(_, _, let state)? = detail {
                return (p.target, running || state == .running)
            }
            return nil
        }
    }

    static func label(_ item: TurnItem) -> String {
        switch item {
        case .thinking(_, let text, _, _): "Thinking: \(text)"
        case .tool(_, let p, _, _): "\(p.verb) \(p.target)"
        }
    }

    /// What a user message is drawn as: its words, and the pictures its tokens name.
    func bubble(_ m: ChatMessage) -> (words: String, pictures: [String]) {
        let s = ImageAttachments.split(m.text)
        return (s.words, s.paths)
    }
}

/// `AppModel.sessionState(hostStatus:)`, which lives in the executable target.
enum AppModelMirror {
    static func sessionState(_ s: String) -> SessionState {
        switch s {
        case "working", "cancelling", "waiting": .working
        case "idle": .idle
        case "error": .error
        case "needs_user_permission", "needs_plan_response", "needs_user_input": .blocked
        default: .unknown
        }
    }
}

struct DownTransport: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw TransportError.connectionRefused }
}
