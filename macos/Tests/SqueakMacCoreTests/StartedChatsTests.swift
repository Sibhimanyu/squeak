import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct StartedChatsTests {
    private let now = Date(timeIntervalSince1970: 1_000_000)
    private func row(_ id: String) -> HostSession {
        NativeAdapter.started(NativeSession(id: id, cwd: "/p/greenroom/hong-kong", agent: "claude"))
    }

    @Test func newChatNotYetListedIsNotStale() {
        var started = StartedChats()
        let new = row("n1")
        started.add(new, at: now)
        #expect(started.resolve(new.key, listed: [], now: now.addingTimeInterval(30))?.key == new.key)
    }

    @Test func listedRowWinsAndPrunes() {
        var started = StartedChats()
        let new = row("n1")
        started.add(new, at: now)
        #expect(started.resolve(new.key, listed: [new], now: now)?.key == new.key)
        started.prune(listed: [new], now: now)
        #expect(started.resolve(new.key, listed: [], now: now) == nil)
    }

    @Test func reallyGoneIsStale() {
        var started = StartedChats()
        let new = row("n1")
        started.add(new, at: now)
        #expect(started.resolve(new.key, listed: [], now: now.addingTimeInterval(StartedChats.grace + 1)) == nil)
        #expect(started.resolve(row("other").key, listed: [], now: now) == nil)
    }

    @Test func staleWordingNamesConductorOnlyForConductorChats() {
        #expect(!StartedChats.staleNote(for: row("n1").key).contains("Conductor"))
        let c = SessionKey(provider: "conductor", workspaceId: "w", hostSessionId: "abc")
        #expect(StartedChats.staleNote(for: c).contains("Conductor"))
    }
}
