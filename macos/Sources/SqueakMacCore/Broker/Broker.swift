import Foundation

public enum PollMode: Sendable, Equatable {
    /// A window is visible.
    case foreground
    case background
}

public enum BrokerEvent: Sendable, Equatable {
    case catalogChanged
    case messagesChanged(SessionKey)
    case connection(AdapterHealth)
    case notify(NotificationEvent)
}

/// Owns the session catalog, per-session messages, in-flight sends and drafts.
/// Adapters do the talking; the broker decides what the UI sees.
public actor Broker {
    public nonisolated let events: AsyncStream<BrokerEvent>
    private let continuation: AsyncStream<BrokerEvent>.Continuation

    private let adapters: [any HostAdapter]
    private let clock: any BrokerClock
    private let cache: EncryptedCache?
    private let draftStore: DraftStore?
    private let foregroundInterval: Duration
    private let backgroundInterval: Duration
    private let transcriptLimit: Int
    private let nudgeDebounce: Duration

    private var perAdapter: [String: [HostSession]] = [:]
    private var owner: [SessionKey: String] = [:]
    private var catalog: [HostSession] = []
    private var previousForNotifications: [HostSession]?
    private var hostMessages: [SessionKey: [ChatMessage]] = [:]
    private var locals: [SessionKey: [ChatMessage]] = [:]
    private var drafts: [SessionKey: String] = [:]
    private var health: [String: AdapterHealth] = [:]
    private var lastSynced: [String: Date] = [:]
    private var mode: PollMode = .background
    private var focused: SessionKey?
    private var pollTask: Task<Void, Never>?
    private var nudgeTask: Task<Void, Never>?
    private var refreshing = false
    private var refreshAgain = false

    public init(
        adapters: [any HostAdapter],
        clock: any BrokerClock = SystemBrokerClock(),
        cache: EncryptedCache? = nil,
        draftStore: DraftStore? = nil,
        foregroundInterval: Duration = .seconds(2),
        backgroundInterval: Duration = .seconds(10),
        transcriptLimit: Int = 200,
        nudgeDebounce: Duration = .milliseconds(200)
    ) {
        self.nudgeDebounce = nudgeDebounce
        self.adapters = adapters
        self.clock = clock
        self.cache = cache
        self.draftStore = draftStore
        self.foregroundInterval = foregroundInterval
        self.backgroundInterval = backgroundInterval
        self.transcriptLimit = transcriptLimit
        (events, continuation) = AsyncStream.makeStream(of: BrokerEvent.self)
    }

    // MARK: Reading state

    public func sessions() -> [HostSession] { catalog }

    public func session(for key: SessionKey) -> HostSession? { catalog.first { $0.key == key } }

    public func healths() -> [AdapterHealth] {
        adapters.compactMap { health[$0.id] }
    }

    /// What the conversation shows: the host's messages, our own sends the host has
    /// not shown yet, and delivery state on the ones it has.
    public func messages(for key: SessionKey) -> [ChatMessage] {
        var host = hostMessages[key] ?? []
        let mine = locals[key] ?? []
        var confirmedByHostId: [String: ChatMessage] = [:]
        for l in mine where l.state == .confirmed { confirmedByHostId[l.turnId ?? ""] = l }
        var lastConfirmed: UUID?
        for i in host.indices {
            if host[i].role == .user {
                if let l = confirmedByHostId[host[i].id] {
                    host[i].clientId = l.clientId
                    host[i].delivery = l.delivery
                    host[i].deliveryNote = l.deliveryNote
                    host[i].state = .confirmed
                    lastConfirmed = l.clientId
                } else {
                    lastConfirmed = nil
                }
            } else {
                host[i].inReplyTo = lastConfirmed
            }
        }
        let pending = mine.filter { $0.state != .confirmed }.sorted { ($0.at ?? .distantPast) < ($1.at ?? .distantPast) }
        return host + pending
    }

    public func connectionSummary() -> AdapterHealth? {
        healths().first { $0.status != .connected } ?? healths().first
    }

    // MARK: Mode and focus

    public func setMode(_ mode: PollMode) { self.mode = mode }

    public func setFocused(_ key: SessionKey?) { focused = key }

    public var currentInterval: Duration { mode == .foreground ? foregroundInterval : backgroundInterval }

    // MARK: Polling

    public func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in await self?.runPollingLoop() }
    }

    public func stop() {
        pollTask?.cancel()
        pollTask = nil
        nudgeTask?.cancel()
        nudgeTask = nil
    }

    /// Something the adapters read just changed (Conductor wrote its database):
    /// refresh now rather than at the next tick. A burst of nudges becomes one
    /// refresh `nudgeDebounce` after the first. The timers stay as the fallback.
    public func nudge() {
        guard nudgeTask == nil else { return }
        let debounce = nudgeDebounce
        nudgeTask = Task { [weak self] in
            try? await Task.sleep(for: debounce)
            guard !Task.isCancelled, let self else { return }
            await self.runNudge()
        }
    }

    private func runNudge() async {
        // Cleared first, so a write landing during the refresh schedules another.
        nudgeTask = nil
        await refresh()
        if mode == .foreground { await refreshTranscript() }
    }

    /// Ends the event stream (consumers' `for await` loops finish).
    public func finish() {
        stop()
        continuation.finish()
    }

    /// Refreshes, then sleeps for the current interval, until cancelled or the
    /// clock's sleep throws. Exposed so tests can drive it with a fake clock.
    public func runPollingLoop() async {
        while !Task.isCancelled {
            await refresh()
            if mode == .foreground { await refreshTranscript() }
            do { try await clock.sleep(for: currentInterval) } catch { break }
        }
    }

    /// One discover pass over every adapter.
    public func refresh() async {
        // Polls and nudges can arrive together; two overlapping discovers would
        // only race to publish the same answer. Run once more afterwards instead.
        if refreshing {
            refreshAgain = true
            return
        }
        refreshing = true
        defer { refreshing = false }
        repeat {
            refreshAgain = false
            await refreshOnce()
        } while refreshAgain && !Task.isCancelled
    }

    private func refreshOnce() async {
        var anySuccess = false
        for adapter in adapters {
            do {
                let found = try await adapter.discover()
                perAdapter[adapter.id] = found
                lastSynced[adapter.id] = clock.now()
                setHealth(AdapterHealth(adapterId: adapter.id, status: .connected, lastSyncedAt: clock.now()))
                anySuccess = true
            } catch {
                // Keep the last known sessions; the connection pill says they are stale.
                setHealth(AdapterHealth(adapterId: adapter.id, status: Self.status(for: error), lastSyncedAt: lastSynced[adapter.id]))
            }
        }
        guard anySuccess else { return }
        var merged: [HostSession] = []
        var seen = Set<SessionKey>()
        var newOwner: [SessionKey: String] = [:]
        for adapter in adapters {
            for s in perAdapter[adapter.id] ?? [] where seen.insert(s.key).inserted {
                merged.append(s)
                newOwner[s.key] = adapter.id
            }
        }
        owner = newOwner
        let changed = merged != catalog
        let notifications = NotificationPolicy.detect(previous: previousForNotifications, current: merged)
        previousForNotifications = merged
        catalog = merged
        if changed { continuation.yield(.catalogChanged) }
        for n in notifications { continuation.yield(.notify(n)) }
    }

    /// Reads the transcript of the focused session and reconciles our own sends against it.
    public func refreshTranscript() async {
        guard let key = focused, let session = session(for: key), let adapter = adapter(for: key) else { return }
        do {
            let fetched = try await adapter.transcript(for: session, limit: transcriptLimit)
            let merged = Self.dedupe(fetched)
            var changed = merged != (hostMessages[key] ?? [])
            hostMessages[key] = merged
            if reconcile(key) { changed = true }
            if changed {
                continuation.yield(.messagesChanged(key))
                if let cache { try? await cache.putMessages(merged, for: key) }
            }
        } catch {
            setHealth(AdapterHealth(adapterId: adapter.id, status: Self.status(for: error), lastSyncedAt: lastSynced[adapter.id]))
        }
    }

    /// The agent's latest message in a session, for cards that show the question.
    /// Reads a short transcript tail; never touches the focused conversation's cache.
    public func lastAgentText(for key: SessionKey) async -> String? {
        guard let session = session(for: key), let adapter = adapter(for: key) else { return nil }
        guard let tail = try? await adapter.transcript(for: session, limit: 8) else { return nil }
        return tail.last { $0.role == .assistant && !$0.text.isEmpty }?.text
    }

    public func activity(for key: SessionKey) async throws -> [ActivityStep] {
        guard let session = session(for: key), let adapter = adapter(for: key) else { return [] }
        return try await adapter.activity(for: session)
    }

    public func openInHostURL(for key: SessionKey) -> URL? {
        guard let session = session(for: key), let adapter = adapter(for: key) else { return nil }
        return adapter.openInHostURL(for: session)
    }

    /// Loads cached messages so a conversation opens instantly (and offline).
    public func restoreFromCache() async {
        if let cache, let all = try? await cache.allMessages() {
            for (key, list) in all where hostMessages[key] == nil { hostMessages[key] = list }
        }
        if let draftStore, let saved = try? await draftStore.all() {
            for (k, v) in saved where drafts[k] == nil { drafts[k] = v }
        }
    }

    // MARK: Sending

    /// Sends once. Calling again with the same `clientId` returns what happened the
    /// first time and never reaches the adapter again: a possibly-delivered message
    /// is confirmed from the transcript, not re-sent.
    @discardableResult
    public func send(_ text: String, to key: SessionKey, clientId: UUID = UUID(), mode: SendMode = .queue) async -> SendResult {
        if let existing = locals[key]?.first(where: { $0.clientId == clientId }) {
            return Self.result(from: existing.state)
        }
        let stamp = clock.now()
        func record(_ state: MessageState) {
            locals[key, default: []].append(ChatMessage(
                id: "local-\(clientId.uuidString)", role: .user, text: text, at: stamp, clientId: clientId, state: state
            ))
            continuation.yield(.messagesChanged(key))
        }
        guard let session = session(for: key), let adapter = adapter(for: key) else {
            let r = SendResult.notSent(reason: "That session is no longer available")
            record(r.messageState)
            return r
        }
        if case .unsupported(let reason) = session.capabilities.send {
            let r = SendResult.notSent(reason: reason)
            record(r.messageState)
            return r
        }
        // Recorded before awaiting, so a re-entrant call with this id sees it.
        record(.pending)
        let result = await adapter.send(text, to: session, clientId: clientId, mode: mode)
        setLocalState(clientId, in: key, to: result.messageState)
        switch result {
        case .accepted, .uncertain:
            // The text left our hands; leaving it as a draft would invite a double send.
            await setDraft(nil, for: key)
        case .refused, .notSent:
            break
        }
        continuation.yield(.messagesChanged(key))
        return result
    }

    public func localState(clientId: UUID, in key: SessionKey) -> MessageState? {
        locals[key]?.first { $0.clientId == clientId }?.state
    }

    // MARK: Drafts

    public func draft(for key: SessionKey) -> String? { drafts[key] }

    public func setDraft(_ text: String?, for key: SessionKey) async {
        let value = text.flatMap { $0.isEmpty ? nil : $0 }
        drafts[key] = value
        if let draftStore {
            if let value { try? await draftStore.save(value, for: key) } else { try? await draftStore.clear(for: key) }
        }
    }

    // MARK: Internals

    private func adapter(for key: SessionKey) -> (any HostAdapter)? {
        guard let id = owner[key] else { return nil }
        return adapters.first { $0.id == id }
    }

    private func setHealth(_ h: AdapterHealth) {
        guard health[h.adapterId] != h else { return }
        health[h.adapterId] = h
        continuation.yield(.connection(h))
    }

    private static func status(for error: Error) -> ConnectionStatus {
        switch error as? AdapterError {
        case .daemonDown: .daemonDown
        case .tokenMissing: .tokenMissing
        case .tokenRejected: .degraded("Squeak rejected the access token")
        case .timedOut: .degraded("Squeak is not answering")
        case .http(let c): .degraded("Unexpected response (HTTP \(c))")
        case .badResponse(let m): .degraded(m)
        case nil: .degraded("Unexpected error")
        }
    }

    private static func result(from state: MessageState?) -> SendResult {
        switch state {
        case .accepted(let via, let delivery, let note): .accepted(via: via, delivery: delivery, note: note)
        case .refused(let r): .refused(reason: r)
        case .notSent(let r): .notSent(reason: r)
        case .uncertain(let r): .uncertain(reason: r)
        case .confirmed: .accepted(via: "confirmed")
        case .pending, .draft, nil: .uncertain(reason: "This message is already being sent")
        }
    }

    private func setLocalState(_ clientId: UUID, in key: SessionKey, to state: MessageState) {
        guard var list = locals[key], let i = list.firstIndex(where: { $0.clientId == clientId }) else { return }
        // Already seen in the transcript while the request was in flight: stays confirmed.
        if list[i].state == .confirmed { return }
        list[i].state = state
        locals[key] = list
    }

    /// Host ids are unique; a repeated id keeps its first position and its latest text.
    static func dedupe(_ messages: [ChatMessage]) -> [ChatMessage] {
        var index: [String: Int] = [:]
        var out: [ChatMessage] = []
        for m in messages {
            if let i = index[m.id] { out[i] = m } else {
                index[m.id] = out.count
                out.append(m)
            }
        }
        return out
    }

    /// Marks our sends as confirmed when the transcript shows them. A confirmed local
    /// keeps the host message id in `turnId` so `messages(for:)` can attach it.
    private func reconcile(_ key: SessionKey) -> Bool {
        guard var list = locals[key], !list.isEmpty else { return false }
        var claimed = Set(list.compactMap { $0.state == .confirmed ? $0.turnId : nil })
        var changed = false
        let host = hostMessages[key] ?? []
        for i in list.indices {
            switch list[i].state {
            case .pending, .accepted, .uncertain: break
            default: continue
            }
            let wanted = list[i].text.trimmingCharacters(in: .whitespacesAndNewlines)
            let sentAt = list[i].at
            guard let match = host.first(where: { m in
                m.role == .user && !claimed.contains(m.id)
                    && m.text.trimmingCharacters(in: .whitespacesAndNewlines) == wanted
                    && (m.at == nil || sentAt == nil || m.at! >= sentAt!.addingTimeInterval(-5))
            }) else { continue }
            claimed.insert(match.id)
            if case .accepted(_, let delivery, let note) = list[i].state {
                list[i].delivery = delivery
                list[i].deliveryNote = note
            }
            list[i].state = .confirmed
            list[i].turnId = match.id
            changed = true
        }
        if changed { locals[key] = list }
        return changed
    }
}
