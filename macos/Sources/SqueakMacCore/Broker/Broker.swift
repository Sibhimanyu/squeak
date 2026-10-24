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

/// The outcome of reading one chat's transcript outside the focused conversation.
public enum TranscriptRead: Sendable, Equatable {
    case messages([ChatMessage], fetchedAt: Date)
    /// The broker does not know this chat (archived, deleted, or the catalog is not loaded yet).
    case sessionGone
    /// Squeak's service or token is not reachable.
    case offline
    case failed
}

/// A notification's event pinned to its reply, plus the messages worth keeping for a later click.
public struct NotificationCapture: Sendable, Equatable {
    public var anchor: NotificationAnchor?
    public var messages: [ChatMessage]
}

/// How far back a chat's history has been read, for the row at the top of the conversation.
public struct EarlierPaging: Sendable, Equatable {
    /// The first message of the chat is loaded: "Start of chat".
    public var reachedStart = false
    public var loading = false
    /// Why the last attempt failed; the row offers a retry.
    public var error: String?
    public var canLoad: Bool { !reachedStart && !loading }

    public init(reachedStart: Bool = false, loading: Bool = false, error: String? = nil) {
        self.reachedStart = reachedStart
        self.loading = loading
        self.error = error
    }
}

public enum EarlierResult: Sendable, Equatable {
    case loaded(Int)
    case reachedStart
    case failed(String)
    /// Another page is already being read.
    case busy
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
    /// Where the next older page starts, per chat (the oldest loaded message's cursor, or the scan's).
    private var pagingCursor: [SessionKey: String] = [:]
    private var reachedStart: Set<SessionKey> = []
    private var loadingEarlier: Set<SessionKey> = []
    private var earlierError: [SessionKey: String] = [:]
    /// Chats whose messages were read from the host this run (not only restored from the cache).
    private var liveRead: Set<SessionKey> = []
    /// Delivered sends the transcript still has not shown are dropped after this, once the agent is not working.
    static let settleAfter: TimeInterval = 600
    /// A send that was refused or never left stays for the person to fix, then goes.
    static let failureLinger: TimeInterval = 3600
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

    /// What the conversation shows: the host's messages, our own sends the host has not shown yet, and
    /// delivery state on the ones it has. An unshown send is placed by time against the transcript: while
    /// the agent works it waits at the end (queued, steered); once the agent is done it sits where it was
    /// sent, before the reply that answered it, and is dropped when it was delivered and the transcript has
    /// moved past it (the transcript's own copy is the message then).
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
        let working = session(for: key)?.state == .working
        let now = clock.now()
        let live = liveRead.contains(key)
        let pending = mine.filter { $0.state != .confirmed }
            .filter { Self.shows($0, host: host, working: working, live: live, now: now) }
            .sorted { ($0.at ?? .distantPast) < ($1.at ?? .distantPast) }
        if working { return host + pending }
        var out = host
        for l in pending {
            let at = l.at ?? now
            let index = out.firstIndex { ($0.at ?? .distantPast) > at } ?? out.endIndex
            out.insert(l, at: index)
        }
        return out
    }

    /// Whether an unshown send is still drawn. A delivered one (accepted, or uncertain) is not once the
    /// agent is done and the transcript has a newer message than it, or it has aged out; nor while the
    /// transcript is only a stale copy from the cache and the send is not brand new.
    static func shows(_ l: ChatMessage, host: [ChatMessage], working: Bool, live: Bool, now: Date) -> Bool {
        let age = l.at.map { now.timeIntervalSince($0) } ?? 0
        switch l.state {
        case .accepted, .uncertain:
            // Beside a cached copy of the chat (not yet read from the host) a send that is not brand new
            // has no place to be put: wait for the first live read.
            guard live || age < 3 else { return false }
            if working { return true }
            if host.contains(where: { ($0.at ?? .distantPast) > (l.at ?? now) }) { return false }
            return age <= settleAfter
        case .refused, .notSent:
            return age <= failureLinger
        default:
            return true
        }
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
        let notifications = NotificationPolicy.detect(previous: previousForNotifications, current: merged, at: clock.now())
        previousForNotifications = merged
        catalog = merged
        if changed { continuation.yield(.catalogChanged) }
        for n in notifications { continuation.yield(.notify(n)) }
        await reconcileUnfocused()
    }

    /// A send to a chat that is not on screen is confirmed too, so it never lingers as "Sent" under a
    /// finished turn. Only chats with a send still waiting are read, and only a short tail.
    private func reconcileUnfocused() async {
        for (key, list) in locals where key != focused {
            guard list.contains(where: { l in
                switch l.state {
                case .pending, .accepted, .uncertain: true
                default: false
                }
            }) else { continue }
            await readWindow(key, limit: 40)
        }
    }

    /// Reads the transcript of the focused session and reconciles our own sends against it.
    public func refreshTranscript() async {
        guard let key = focused else { return }
        await readWindow(key, limit: transcriptLimit)
    }

    /// Reads the newest `limit` messages and merges them with what is already loaded (never replacing
    /// pages read further back), then reconciles our sends against the result.
    private func readWindow(_ key: SessionKey, limit: Int) async {
        guard let session = session(for: key), let adapter = adapter(for: key) else { return }
        do {
            let page = try await adapter.transcriptPage(for: session, limit: limit, before: nil)
            let window = Self.dedupe(page.messages)
            let existing = hostMessages[key] ?? []
            let (merged, keptOlder) = Self.merge(window: window, into: existing)
            var changed = merged != existing
            hostMessages[key] = merged
            if liveRead.insert(key).inserted { changed = true }
            if !keptOlder {
                // A different stretch of the chat (first read, or a gap): paging starts from this window.
                if let next = page.nextBefore { pagingCursor[key] = next; reachedStart.remove(key) } else {
                    pagingCursor[key] = nil
                    reachedStart.insert(key)
                }
            }
            if reconcile(key) { changed = true }
            if changed {
                continuation.yield(.messagesChanged(key))
                if let cache, key == focused { try? await cache.putMessages(Array(merged.suffix(Self.cachedMessages)), for: key) }
            }
        } catch {
            setHealth(AdapterHealth(adapterId: adapter.id, status: Self.status(for: error), lastSyncedAt: lastSynced[adapter.id]))
        }
    }

    static let cachedMessages = 400

    /// The cache appends pages in the order they were read, so an older page sits after newer ones: put a
    /// list whose messages all carry a cursor back in chat order.
    static func chatOrder(_ list: [ChatMessage]) -> [ChatMessage] {
        let cursors = list.compactMap { $0.cursor.flatMap(Int64.init) }
        guard cursors.count == list.count, cursors != cursors.sorted() else { return list }
        return list.sorted { ($0.cursor.flatMap(Int64.init) ?? 0) < ($1.cursor.flatMap(Int64.init) ?? 0) }
    }

    /// The newest window merged into what is loaded. When the window overlaps it (its first message is
    /// already there), everything older stays and the window replaces the rest; otherwise the window is
    /// all that is known and the older part is dropped rather than joined across a gap it cannot see.
    /// `keptOlder` says older messages survived.
    static func merge(window: [ChatMessage], into existing: [ChatMessage]) -> (messages: [ChatMessage], keptOlder: Bool) {
        guard let first = window.first else { return (existing, !existing.isEmpty) }
        guard let i = existing.firstIndex(where: { $0.id == first.id }) else { return (window, false) }
        // Older rows we can no longer page from (restored without cursors) are not kept.
        if i > 0, existing[0].cursor == nil { return (window, false) }
        return (Array(existing[..<i]) + window, i > 0)
    }

    // MARK: Earlier messages

    public func paging(for key: SessionKey) -> EarlierPaging {
        EarlierPaging(reachedStart: reachedStart.contains(key), loading: loadingEarlier.contains(key), error: earlierError[key])
    }

    /// Reads the next older page (about `count` messages) and puts it in front of what is loaded. One at
    /// a time per chat; a failure is kept for the retry row, never swallowed.
    @discardableResult
    public func loadEarlier(for key: SessionKey, count: Int = 20) async -> EarlierResult {
        if loadingEarlier.contains(key) { return .busy }
        guard !reachedStart.contains(key) else { return .reachedStart }
        guard let session = session(for: key), let adapter = adapter(for: key) else {
            earlierError[key] = "That chat is no longer available."
            continuation.yield(.messagesChanged(key))
            return .failed("That chat is no longer available.")
        }
        // The oldest loaded message's cursor is a valid place to resume (restored from the cache, say).
        guard let cursor = pagingCursor[key] ?? hostMessages[key]?.first(where: { $0.cursor != nil })?.cursor else {
            reachedStart.insert(key)
            continuation.yield(.messagesChanged(key))
            return .reachedStart
        }
        loadingEarlier.insert(key)
        earlierError[key] = nil
        continuation.yield(.messagesChanged(key))
        defer { loadingEarlier.remove(key) }
        do {
            let page = try await adapter.transcriptPage(for: session, limit: count, before: cursor)
            // The window may have been replaced while this read ran; its cursor is then not ours to move.
            let current = pagingCursor[key] ?? hostMessages[key]?.first(where: { $0.cursor != nil })?.cursor
            guard current == cursor else {
                continuation.yield(.messagesChanged(key))
                return .loaded(0)
            }
            let have = Set((hostMessages[key] ?? []).map(\.id))
            let older = Self.dedupe(page.messages).filter { !have.contains($0.id) }
            hostMessages[key] = older + (hostMessages[key] ?? [])
            if let next = page.nextBefore { pagingCursor[key] = next } else {
                pagingCursor[key] = nil
                reachedStart.insert(key)
            }
            loadingEarlier.remove(key)
            continuation.yield(.messagesChanged(key))
            if let cache, let all = hostMessages[key] { try? await cache.putMessages(Array(all.suffix(Self.cachedMessages)), for: key) }
            return page.nextBefore == nil && older.isEmpty ? .reachedStart : .loaded(older.count)
        } catch {
            let reason = "Couldn't load earlier messages."
            earlierError[key] = reason
            loadingEarlier.remove(key)
            continuation.yield(.messagesChanged(key))
            return .failed(reason)
        }
    }

    /// The turn the chat is on, from its newest message, for answers that must not land on a later one.
    public func currentTurnId(for key: SessionKey) -> String? {
        hostMessages[key]?.last(where: { $0.turnId != nil })?.turnId
    }

    /// The agent's latest message in a session, for cards that show the question.
    /// Reads a short transcript tail; never touches the focused conversation's cache.
    public func lastAgentText(for key: SessionKey) async -> String? {
        guard let session = session(for: key), let adapter = adapter(for: key) else { return nil }
        guard let tail = try? await adapter.transcript(for: session, limit: 8) else { return nil }
        return tail.last { $0.role == .assistant && !$0.text.isEmpty }?.text
    }

    /// A transcript read for one chat that belongs to nobody's focus: it neither sets the focused
    /// session nor touches its messages or the cache, so a notification's context can load while
    /// the conversation window shows another chat. The time is taken before the read, so anything
    /// that happened after it is not claimed as seen.
    public func readTranscript(for key: SessionKey, limit: Int = 80) async -> TranscriptRead {
        guard let session = session(for: key), let adapter = adapter(for: key) else { return .sessionGone }
        let started = clock.now()
        do {
            let fetched = try await adapter.transcript(for: session, limit: limit)
            if Task.isCancelled { return .failed }
            return .messages(Self.dedupe(fetched), fetchedAt: started)
        } catch {
            switch error as? AdapterError {
            case .daemonDown?, .tokenMissing?, .timedOut?: return .offline
            default: return .failed
            }
        }
    }

    /// Pins a notification to the reply it is about, at the moment it happens. Always returns the
    /// event's own anchor; the message identity is there only if the read worked.
    public func capture(_ event: NotificationEvent, limit: Int = 40) async -> NotificationCapture {
        guard case .messages(let list, _) = await readTranscript(for: event.key, limit: limit) else {
            return NotificationCapture(anchor: NotificationAnchor(event: event), messages: [])
        }
        guard let anchor = NotificationContextPolicy.anchorNow(event: event, messages: list) else {
            return NotificationCapture(anchor: nil, messages: [])
        }
        let content = NotificationContextPolicy.resolve(messages: list, anchor: anchor)
        return NotificationCapture(anchor: anchor, messages: content.cacheable)
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
            for (key, list) in all where hostMessages[key] == nil { hostMessages[key] = Self.chatOrder(list) }
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
    public func send(
        _ text: String, to key: SessionKey, clientId: UUID = UUID(), mode: SendMode = .queue, answersTurn: String? = nil
    ) async -> SendResult {
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
        // `.unavailable` (the service is down) passes: the adapter rechecks and says so if it still is.
        if case .unsupported(let reason) = session.capabilities.send {
            let r = SendResult.notSent(reason: reason)
            record(r.messageState)
            return r
        }
        // Recorded before awaiting, so a re-entrant call with this id sees it.
        record(.pending)
        let result = await adapter.send(text, to: session, clientId: clientId, mode: mode, answersTurn: answersTurn)
        // The send rechecked the service; let every surface see what it learned.
        if session.capabilities.send.isServiceUnavailable { await refresh() }
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

    /// Marks our sends as confirmed when the transcript shows them (by text, tolerating attachment markers
    /// and clipping). A confirmed local keeps the host message id in `turnId` so `messages(for:)` can attach
    /// it. Sends that were refused and have outlived their welcome are dropped.
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
            let sent = list[i].text
            let sentAt = list[i].at
            guard let match = host.first(where: { m in
                m.role == .user && !claimed.contains(m.id)
                    && SentTextMatch.matches(sent: sent, host: m.text)
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
        let now = clock.now()
        let before = list.count
        list.removeAll { l in
            switch l.state {
            case .refused, .notSent: (l.at.map { now.timeIntervalSince($0) } ?? 0) > Self.failureLinger
            default: false
            }
        }
        if list.count != before { changed = true }
        if changed { locals[key] = list }
        return changed
    }
}
