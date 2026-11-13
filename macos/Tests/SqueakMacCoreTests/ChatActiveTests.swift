import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct ChatActiveTests {
    private let key = SessionKey(provider: "squeak", hostSessionId: "a")

    @Test func idleWithBackgroundIsActive() {
        let viaDucklings = HostSession(key: key, state: .finished, ducklings: DucklingSet(running: 1))
        let viaShell = HostSession(key: key, state: .finished, backgroundCount: 1)
        #expect(viaDucklings.isActive && viaShell.isActive)
        #expect(ChatMark.of(viaDucklings, unread: false)?.kind == .working)
        #expect(ChatMark.of(viaShell, unread: true)?.kind == .working)
    }

    @Test func idleWithoutBackgroundIsNot() {
        let s = HostSession(key: key, state: .finished, backgroundCount: 0, ducklings: DucklingSet(running: 0))
        #expect(!s.isActive)
        #expect(ChatMark.of(s, unread: false) == nil)
    }

    @Test func workingIsActiveAndDeadIsNot() {
        #expect(HostSession(key: key, state: .working).isActive)
        #expect(!HostSession(key: key, state: .finished, alive: false, ducklings: DucklingSet(running: 1)).isActive)
    }

    @Test func blockedStillWins() {
        let s = HostSession(key: key, state: .blocked, ducklings: DucklingSet(running: 1))
        #expect(ChatMark.of(s, unread: false)?.kind == .waiting)
    }
}
