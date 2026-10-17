import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Broker")
struct BrokerTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    func make(_ adapters: [FakeAdapter], clock: FakeClock = FakeClock(), cache: EncryptedCache? = nil, drafts: DraftStore? = nil) -> Broker {
        Broker(adapters: adapters, clock: clock, cache: cache, draftStore: drafts)
    }

    @Test func dedupesSessionsByHostIdAcrossAdapters() async {
        let s = makeSession("dup")
        let a = FakeAdapter(id: "a", sessions: [s])
        let b = FakeAdapter(id: "b", sessions: [s, makeSession("other")])
        let broker = make([a, b])
        await broker.refresh()
        #expect(await broker.sessions().count == 2)
    }

    @Test func dedupesMessagesByHostId() async {
        let s = makeSession("c1")
        let a = FakeAdapter(sessions: [s])
        await a.setTranscript([
            ChatMessage(id: "m1", role: .user, text: "q"),
            ChatMessage(id: "m2", role: .assistant, text: "partial"),
            ChatMessage(id: "m2", role: .assistant, text: "final"),
        ])
        let broker = make([a])
        await broker.refresh()
        await broker.setFocused(s.key)
        await broker.refreshTranscript()
        let msgs = await broker.messages(for: s.key)
        #expect(msgs.map(\.id) == ["m1", "m2"])
        #expect(msgs[1].text == "final")
    }

    @Test func pollingIntervalsFollowMode() async {
        let clock = FakeClock(maxTicks: 2)
        let a = FakeAdapter(sessions: [makeSession("c1")])
        let broker = make([a], clock: clock)
        await broker.setMode(.foreground)
        await broker.runPollingLoop()
        #expect(clock.recordedSleeps == [.seconds(2), .seconds(2)])
        #expect(await a.discoverCount == 2)

        let clock2 = FakeClock(maxTicks: 1)
        let broker2 = make([a], clock: clock2)
        await broker2.setMode(.background)
        await broker2.runPollingLoop()
        #expect(clock2.recordedSleeps == [.seconds(10)])
    }

    @Test func connectionHealthIsHonestAboutLastSync() async {
        let clock = FakeClock()
        let a = FakeAdapter(sessions: [makeSession("c1")])
        let broker = make([a], clock: clock)
        await broker.refresh()
        let synced = clock.now()
        clock.advance(60)
        await a.setFailure(.daemonDown)
        await broker.refresh()
        let h = await broker.healths()[0]
        #expect(h.status == .daemonDown)
        #expect(h.lastSyncedAt == synced)
        #expect(await broker.sessions().count == 1) // stale sessions kept, not blanked

        await a.setFailure(.tokenMissing)
        await broker.refresh()
        #expect(await broker.healths()[0].status == .tokenMissing)
        await a.setFailure(nil)
        await broker.refresh()
        #expect(await broker.healths()[0].status == .connected)
    }

    @Test func noNotificationOnFirstLoadThenOnTransition() async {
        let a = FakeAdapter(sessions: [makeSession("c1", state: .working)])
        let broker = make([a])
        await broker.refresh()
        await a.setSessions([makeSession("c1", state: .finished)])
        await broker.refresh()
        await a.setSessions([makeSession("c1", state: .finished)]) // unchanged: nothing
        await broker.refresh()
        await broker.finish()
        var notified: [NotificationEvent] = []
        for await e in broker.events {
            if case .notify(let n) = e { notified.append(n) }
        }
        #expect(notified.count == 1)
        #expect(notified.first?.kind == .finished)
    }

    // MARK: sending

    @Test func sendRecordsPendingThenAcceptedAndClearsDraft() async {
        let s = makeSession("c1")
        let a = FakeAdapter(sessions: [s])
        let broker = make([a])
        await broker.refresh()
        await broker.setDraft("hello", for: s.key)
        let id = UUID()
        let r = await broker.send("hello", to: s.key, clientId: id)
        #expect(r == .accepted(via: "conductor"))
        #expect(await broker.localState(clientId: id, in: s.key) == .accepted(via: "conductor"))
        #expect(await broker.draft(for: s.key) == nil)
        let shown = await broker.messages(for: s.key)
        #expect(shown.count == 1 && shown[0].text == "hello" && shown[0].state == .accepted(via: "conductor"))
    }

    @Test func refusedKeepsDraftForUserToEditAndRetry() async {
        let s = makeSession("c1")
        let a = FakeAdapter(sessions: [s])
        await a.setSendResult(.refused(reason: "Conductor is busy with this chat"))
        let broker = make([a])
        await broker.refresh()
        await broker.setDraft("hello", for: s.key)
        let r = await broker.send("hello", to: s.key)
        #expect(r == .refused(reason: "Conductor is busy with this chat"))
        #expect(await broker.draft(for: s.key) == "hello")
    }

    @Test func uncertainSendNeverResendsAndIsConfirmedOnlyByTranscript() async {
        let s = makeSession("c1")
        let clock = FakeClock()
        let a = FakeAdapter(sessions: [s])
        await a.setSendResult(.uncertain(reason: "timed out"))
        let broker = make([a], clock: clock)
        await broker.refresh()
        await broker.setFocused(s.key)
        let id = UUID()
        _ = await broker.send("ship it", to: s.key, clientId: id)
        #expect(await a.sendCount == 1)

        // Polling and re-calling with the same id never reach the adapter again.
        await broker.refreshTranscript()
        await broker.refresh()
        let again = await broker.send("ship it", to: s.key, clientId: id)
        #expect(again == .uncertain(reason: "timed out"))
        #expect(await a.sendCount == 1)
        #expect(await broker.localState(clientId: id, in: s.key) == .uncertain(reason: "timed out"))

        // The host shows it: now it is confirmed, and shown once.
        await a.setTranscript([
            ChatMessage(id: "h1", role: .user, text: "ship it", at: clock.now(), turnId: "T1"),
            ChatMessage(id: "h2", role: .assistant, text: "done", turnId: "T1"),
        ])
        await broker.refreshTranscript()
        let shown = await broker.messages(for: s.key)
        #expect(shown.map(\.id) == ["h1", "h2"])
        #expect(shown[0].state == .confirmed && shown[0].clientId == id)
        #expect(shown[1].inReplyTo == id)
        #expect(await a.sendCount == 1)
    }

    @Test func similarTextBeforeTheSendDoesNotConfirm() async {
        let s = makeSession("c1")
        let clock = FakeClock()
        let a = FakeAdapter(sessions: [s])
        await a.setSendResult(.uncertain(reason: "timed out"))
        let broker = make([a], clock: clock)
        await broker.refresh()
        await broker.setFocused(s.key)
        // An old identical message from an hour ago.
        await a.setTranscript([ChatMessage(id: "old", role: .user, text: "yes", at: clock.now().addingTimeInterval(-3600))])
        _ = await broker.send("yes", to: s.key)
        await broker.refreshTranscript()
        let shown = await broker.messages(for: s.key)
        #expect(shown.count == 2)
        #expect(shown.last?.state == .uncertain(reason: "timed out"))
    }

    @Test func concurrentSendWithSameIdReachesAdapterOnce() async {
        let s = makeSession("c1")
        let a = FakeAdapter(sessions: [s])
        let broker = make([a])
        await broker.refresh()
        let id = UUID()
        async let r1 = broker.send("x", to: s.key, clientId: id)
        async let r2 = broker.send("x", to: s.key, clientId: id)
        _ = await (r1, r2)
        #expect(await a.sendCount == 1)
    }

    @Test func unsupportedSendOrMissingSessionIsNotSentWithoutAdapterCall() async {
        let s = makeSession("c1", provider: "claude-desktop", canSend: false)
        let a = FakeAdapter(sessions: [s])
        let broker = make([a])
        await broker.refresh()
        let r1 = await broker.send("hi", to: s.key)
        let r2 = await broker.send("hi", to: SessionKey(provider: "conductor", hostSessionId: "ghost"))
        guard case .notSent = r1, case .notSent = r2 else { Issue.record("expected notSent"); return }
        #expect(await a.sendCount == 0)
    }

    @Test func draftsPersistThroughTheStore() async throws {
        let cache = EncryptedCache(configuration: .init(directory: tempDirectory()), keyStore: MemoryKeyStore())
        let store = DraftStore(cache: cache)
        let s = makeSession("c1")
        let broker = make([FakeAdapter(sessions: [s])], drafts: store)
        await broker.setDraft("unsent thought", for: s.key)
        #expect(try await store.load(for: s.key) == "unsent thought")
        let fresh = make([FakeAdapter(sessions: [s])], drafts: store)
        await fresh.restoreFromCache()
        #expect(await fresh.draft(for: s.key) == "unsent thought")
    }

    @Test func transcriptsAreCachedAndRestored() async throws {
        let cache = EncryptedCache(configuration: .init(directory: tempDirectory()), keyStore: MemoryKeyStore())
        let s = makeSession("c1")
        let a = FakeAdapter(sessions: [s])
        await a.setTranscript([ChatMessage(id: "m1", role: .assistant, text: "cached text")])
        let broker = make([a], cache: cache)
        await broker.refresh()
        await broker.setFocused(s.key)
        await broker.refreshTranscript()
        let offline = make([FakeAdapter()], cache: cache)
        await offline.restoreFromCache()
        #expect(await offline.messages(for: s.key).map(\.text) == ["cached text"])
    }
}
