import Foundation
import Observation
import SqueakMacCore

/// A Conductor chat's queued messages for the Mac window: read from the daemon while the chat is open and
/// working, changed through its steer/delete routes. Never touches the database itself and never retries a change.
@MainActor @Observable
final class QueueStore {
    private(set) var items: [QueuedMessage] = []
    /// A fixed sentence when the last change did not go through; cleared by the next refresh that works.
    private(set) var problem: String?
    /// The message a steer or delete is in flight for, so its buttons rest meanwhile.
    private(set) var busyId: String?

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
    }

    /// Reads every ~2.5 s until cancelled; the caller runs it under `.task(id:)` while the chat is open and
    /// working, and clears it (one last read) when the turn ends.
    func poll(sessionId: String) async {
        while !Task.isCancelled {
            await refresh(sessionId: sessionId)
            try? await Task.sleep(for: .seconds(2.5))
        }
    }

    func clear() {
        items = []
        problem = nil
        busyId = nil
    }

    /// Steers the message into the running turn now.
    func steer(_ item: QueuedMessage, sessionId: String) async {
        await change(item, sessionId: sessionId) { await client.promoteQueued(sessionId: sessionId, messageId: item.id) }
    }

    /// Deletes the message. Returns whether it is gone, so an Edit can put the text back only then.
    @discardableResult
    func delete(_ item: QueuedMessage, sessionId: String) async -> Bool {
        await change(item, sessionId: sessionId) { await client.cancelQueued(sessionId: sessionId, messageId: item.id) }
    }

    @discardableResult
    private func change(_ item: QueuedMessage, sessionId: String, _ run: () async -> QueueChangeResult) async -> Bool {
        guard busyId == nil else { return false }
        busyId = item.id
        problem = nil
        let result = await run()
        busyId = nil
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
    func makeQueueStore() -> QueueStore { QueueStore(client: client, demo: demoMode || captureMode) }
}
