import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct HeresayLogicTests {
    @Test func idPrefersUserIdThenHashesEmail() {
        #expect(HeresayIdentity.id(userId: " u123 ", email: "a@b.c") == "u123")
        let a = HeresayIdentity.id(userId: nil, email: "Sam@Example.com ")
        #expect(a == HeresayIdentity.id(userId: "", email: "sam@example.com"))
        #expect(a?.hasPrefix("acct_") == true)
        #expect(a?.contains("sam") == false)
        #expect(HeresayIdentity.id(userId: nil, email: nil) == nil)
        #expect(HeresayIdentity.id(userId: nil, email: "  ") == nil)
    }

    @Test func labelIsLocalPart() {
        #expect(HeresayIdentity.label(email: "sam@example.com") == "sam")
        #expect(HeresayIdentity.label(email: "nope") == nil)
    }

    @Test func nudgeFiresOncePerEpisode() {
        var g = NudgeGate(after: 30)
        let t = Date(timeIntervalSince1970: 1000)
        func look(_ up: Bool, _ s: TimeInterval) -> Bool { g.observe(reachable: up, now: t.addingTimeInterval(s)) }
        let seen = [look(false, 0), look(false, 20), look(false, 31), look(false, 90), look(true, 95), look(false, 100), look(false, 140)]
        #expect(seen == [false, false, true, false, false, false, true])
    }
}
