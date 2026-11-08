import Foundation
import Observation
import SqueakMacCore

/// A Conductor chat's queued messages for the Mac window: read from the daemon while the chat is open and
/// working, changed through its steer/delete routes. Never touches the database itself and never retries a change.
@MainActor @Observable
final class QueueStore {
    private(set) var items: [QueuedMessage] = []
    /// Messages just sent while the chat works, shown at once until the polled queue holds them (PendingQueue.swift).
    private(set) var pending: [PendingQueueItem] = []
    /// When the newest send happened: reads come every second for 10 s after it.
    @ObservationIgnored private var lastSendAt: Date?

    /// What the stack draws: the daemon's queue, then what is still being queued.
    var rows: [QueueRow] { PendingQueue.rows(polled: items.filter { $0.id != hiddenId }, pending: pending) }
    /// A message being deleted leaves the stack at once; it comes back if the daemon says no.
    private var hiddenId: String? { busyKind == .delete ? busyId : nil }
    /// A fixed sentence when the last change did not go through; cleared by the next refresh that works.
    private(set) var problem: String?
    /// The message a steer or delete is in flight for, so its buttons rest meanwhile.
    private(set) var busyId: String?
    private(set) var busyKind: QueueChangeKind?

    @ObservationIgnored private let client: DaemonClient
    @ObservationIgnored private let demo: Bool

    init(client: DaemonClient, demo: Bool) {
        self.client = client
        self.demo = demo
    }

    func refresh(sessionId: String) async {
        guard !demo else { return }
        guard let read = try? await client.queue(sessionId: sessionId) else {
            // Older daemon, relay down or not a Conductor chat: nothing to show, nothing to say.
            if !items.isEmpty { items = [] }
            return
        }
        if read != items { items = read }
        reconcilePending()
    }

    private func reconcilePending() {
        guard !pending.isEmpty else { return }
        let r = PendingQueue.reconcile(pending: pending, polled: items, now: Date())
        if r.pending != pending { pending = r.pending }
    }

    // MARK: Optimistic card

    /// Shows the message in the queue now, before the reply route has answered. Returns the card's id.
    func beginPending(text: String) -> String {
        let item = PendingQueueItem(text: text, sentAt: Date(), baseline: Set(items.map(\.id)))
        pending.append(item)
        lastSendAt = item.sentAt
        return item.id
    }

    /// The reply was taken: read the queue at once and again a moment later, so the real message replaces the card.
    func accepted(_ id: String, sessionId: String) async {
        update(id) { $0.accepted = true }
        await refresh(sessionId: sessionId)
        try? await Task.sleep(for: .milliseconds(300))
        await refresh(sessionId: sessionId)
    }

    /// The reply was not taken: the card says so, with Retry (only when nothing was sent) and Edit.
    func failed(_ id: String, reason: String, unclear: Bool) {
        update(id) { $0.state = unclear ? .unclear(reason: reason) : .failed(reason: reason) }
    }

    func dismissPending(_ id: String) { pending.removeAll { $0.id == id } }

    private func update(_ id: String, _ change: (inout PendingQueueItem) -> Void) {
        guard let i = pending.firstIndex(where: { $0.id == id }) else { return }
        change(&pending[i])
    }

    /// Reads every ~2.5 s until cancelled; the caller runs it under `.task(id:)` while the chat is open and
    /// working, and clears it (one last read) when the turn ends.
    func poll(sessionId: String) async {
        while !Task.isCancelled {
            await refresh(sessionId: sessionId)
            let since = lastSendAt.map { Date().timeIntervalSince($0) }
            try? await Task.sleep(for: .seconds(PendingQueue.pollInterval(sinceSend: since)))
        }
    }

    func clear() {
        items = []
        pending = []
        lastSendAt = nil
        problem = nil
        busyId = nil
        busyKind = nil
    }

    /// Steers the message into the running turn now.
    func steer(_ item: QueuedMessage, sessionId: String) async {
        await change(item, .steer, sessionId: sessionId) { await client.promoteQueued(sessionId: sessionId, messageId: item.id) }
    }

    /// Deletes the message. Returns whether it is gone, so an Edit can put the text back only then.
    @discardableResult
    func delete(_ item: QueuedMessage, sessionId: String) async -> Bool {
        await change(item, .delete, sessionId: sessionId) { await client.cancelQueued(sessionId: sessionId, messageId: item.id) }
    }

    @discardableResult
    private func change(_ item: QueuedMessage, _ kind: QueueChangeKind, sessionId: String, _ run: () async -> QueueChangeResult) async -> Bool {
        guard busyId == nil else { return false }
        busyId = item.id
        busyKind = kind
        problem = nil
        let result = await run()
        busyId = nil
        busyKind = nil
        var gone = false
        switch result {
        case .done: gone = true
        case .alreadySent: problem = "That message already went to Claude."
        case .failed(let reason): problem = reason
        }
        if gone { items.removeAll { $0.id == item.id } }
        await refresh(sessionId: sessionId)
        return gone
    }
}

extension AppModel {
    /// One store per chat, so a send from the composer and the stack under it share the same pending cards.
    func queueStore(for sessionId: String) -> QueueStore {
        if let existing = queueStores[sessionId] { return existing }
        let store = QueueStore(client: client, demo: demoMode || captureMode)
        queueStores[sessionId] = store
        return store
    }
}
