import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct UpdateInstallGateTests {
    @Test func nothingToLoseInstalls() {
        #expect(UpdateInstallGate.onPress(busyTerminals: 0) == .installNow)
    }
    @Test func busyTerminalsAsk() {
        #expect(UpdateInstallGate.onPress(busyTerminals: 2) == .ask(busyTerminals: 2))
        #expect(UpdateInstallGate.question(busyTerminals: 2) == "2 terminal tabs are running commands. Installing closes them.")
        #expect(UpdateInstallGate.question(busyTerminals: 1).contains("1 terminal tab is running a command"))
    }
    @Test func choices() {
        #expect(UpdateInstallGate.apply(.installWhenFree, version: "2.1").waitingFor == "2.1")
        #expect(UpdateInstallGate.apply(.installWhenFree, version: "2.1").install == false)
        #expect(UpdateInstallGate.apply(.installNow, version: "2.1").install)
        #expect(UpdateInstallGate.apply(.cancel, version: "2.1") == (nil, false))
    }
    @Test func waitsThenInstalls() {
        #expect(UpdateInstallGate.onPoll(busyTerminals: 1, waitingFor: "2.1", offered: "2.1") == .keepWaiting)
        #expect(UpdateInstallGate.onPoll(busyTerminals: 0, waitingFor: "2.1", offered: "2.1") == .installNow)
        #expect(UpdateInstallGate.onPoll(busyTerminals: 0, waitingFor: nil, offered: "2.1") == .idle)
        #expect(UpdateInstallGate.onPoll(busyTerminals: 0, waitingFor: "2.1", offered: "2.2") == .idle)
        #expect(UpdateInstallGate.onPoll(busyTerminals: 0, waitingFor: "2.1", offered: nil) == .keepWaiting)
    }
    @Test func busyCountUsesForegroundGroup() {
        #expect(UpdateInstallGate.busyTerminals([(10, 10), (20, 99), (30, nil), (40, 41)]) == 2)
    }
    @Test func rowLines() {
        #expect(UpdateInstallGate.rowLine(version: "2.23.36", chatsWorking: 0, waiting: false) == "Update 2.23.36 ready")
        #expect(UpdateInstallGate.rowLine(version: "2.23.36", chatsWorking: 3, waiting: false) == "Update 2.23.36 ready · 3 chats keep working")
        #expect(UpdateInstallGate.rowLine(version: "2.23.36", chatsWorking: 1, waiting: false).hasSuffix("1 chat keeps working"))
        #expect(UpdateInstallGate.rowLine(version: "x", chatsWorking: 2, waiting: true) == "Installs when your terminals are free")
    }
}

@Suite struct EngineCatchUpTests {
    @Test func waitsWhileBusyRestartsWhenFree() {
        let busy = HostProbe.sessions(statuses: ["working", "idle", "awaiting_answer"])
        #expect(EngineCatchUp.decide(pending: true, probe: busy) == .wait(chats: 2))
        #expect(EngineCatchUp.decide(pending: true, probe: .sessions(statuses: ["idle"])) == .restart)
        #expect(EngineCatchUp.decide(pending: true, probe: .down) == .restart)
        #expect(EngineCatchUp.decide(pending: false, probe: .down) == .none)
        #expect(EngineCatchUp.decide(pending: true, probe: .unreadable) == .wait(chats: nil))
    }
    @Test func restartNowIgnoresBusy() {
        #expect(EngineCatchUp.decide(pending: true, probe: .sessions(statuses: ["working"]), force: true) == .restart)
    }
    @Test func words() {
        #expect(EngineCatchUp.line(chats: 2) == "Engine update waits for 2 chats")
        #expect(EngineCatchUp.line(chats: 1) == "Engine update waits for 1 chat")
        #expect(EngineCatchUp.confirmText(chats: 3) == "Restarting stops 3 running chats.")
    }
    @Test func pendingSurvivesRelaunch() {
        let suite = "engine-catchup-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: suite)!
        defer { d.removePersistentDomain(forName: suite) }
        #expect(EngineCatchUpStore(defaults: d).pending == false)
        EngineCatchUpStore(defaults: d).pending = true
        #expect(EngineCatchUpStore(defaults: d).pending)
    }
}

@Suite struct QuickDraftPersistenceTests {
    @Test func roundTrip() {
        let a = SessionKey(provider: "squeak", hostSessionId: "squeak-native:a")
        var drafts = ComposerDrafts()
        drafts.stash("hello", for: a)
        drafts.stash("before any chat", for: nil)
        let back = ComposerDrafts(entries: drafts.entries)
        #expect(back == drafts)
        #expect(back.text(for: a) == "hello")
        #expect(back.text(for: nil) == "before any chat")
    }
    @Test func sentClearsTheSavedEntry() {
        let a = SessionKey(provider: "squeak", hostSessionId: "squeak-native:a")
        var drafts = ComposerDrafts()
        drafts.stash("hi", for: a)
        let before = drafts.entries
        drafts.sent("hi", to: a)
        let change = DraftSync.changes(old: before, new: drafts.entries)
        #expect(change.clear == [a])
        #expect(change.save.isEmpty)
    }
    @Test func diffSavesOnlyWhatChanged() {
        let a = SessionKey(provider: "x", hostSessionId: "a"), b = SessionKey(provider: "x", hostSessionId: "b")
        let c = DraftSync.changes(old: [a: "1", b: "2"], new: [a: "1", b: "3"])
        #expect(c.save == [b: "3"])
        #expect(c.clear.isEmpty)
    }
}

@Suite struct DraftFlushTests {
    @Test func writeIsDoneWhenWaitReturns() async throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: "flush-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let cache = EncryptedCache(configuration: .init(directory: dir, keyAccount: "k", sizeCap: 1 << 20), keyStore: FileKeyStore(directory: dir))
        let store = DraftStore(cache: cache)
        let a = SessionKey(provider: "squeak", hostSessionId: "squeak-native:a")
        let old = SessionKey(provider: "squeak", hostSessionId: "squeak-native:old")
        try await store.save("stale", for: old)
        let finished = await Task.detached { DraftFlush.waitFor(timeout: 5) { await DraftFlush.reconcile(store, to: [a: "typed last second"]) } }.value
        #expect(finished)
        let all = try await store.all()
        #expect(all == [a: "typed last second"])
    }
    @Test func slowWriteDoesNotHangTheQuit() {
        let start = Date()
        let finished = DraftFlush.waitFor(timeout: 0.2) { try? await Task.sleep(for: .seconds(3)) }
        #expect(!finished)
        #expect(Date().timeIntervalSince(start) < 1.5)
    }
}
