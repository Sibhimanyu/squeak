import Foundation
import Testing
@testable import SqueakMacCore

// Issue #130: one honest connection state. The daemon computes it; the Mac draws it. Actions are done only on cloud confirm.
@Suite struct PondConnectionTests {
    private func summary(_ json: String) throws -> PondSummary {
        try JSONDecoder().decode(PondSummary.self, from: Data(json.utf8))
    }

    @Test func theDaemonsWordIsDecodedAndAnUnknownOneIsDropped() throws {
        let live = try summary(#"{"id":"p","connection":{"state":"live","line":"Live"}}"#)
        #expect(live.connection == PondConnectionInfo(state: .live, line: "Live"))
        let away = try summary(#"{"id":"p","connection":{"state":"owner-offline","line":"Sibhi’s Mac offline"}}"#)
        #expect(away.connection?.state == .ownerOffline)
        #expect(try summary(#"{"id":"p","connection":{"state":"teleporting","line":"?"}}"#).connection == nil)
        #expect(try summary(#"{"id":"p"}"#).connection == nil)
    }

    @Test func anOldAppSaysUpdateSqueakPlainlyEvenWhenReadsFail() throws {
        let p = try summary(#"{"id":"p","connection":{"state":"update-required","line":"Update Squeak to keep using shared Ponds"}}"#)
        #expect(p.connection?.state == .updateRequired)
        let c = PondConnection.resolve(p.connection, freshness: .couldntRead, role: .owner)
        #expect(c == .updateRequired)
        let h = PondDashboardHeader.make(.init(role: .owner, connection: c, connectionLine: p.connection?.line))
        #expect(h.stateLine.hasSuffix("Update Squeak to keep using shared Ponds"))
    }

    @Test func theDashboardLineDrawsTheDaemonsConnectionAndNothingElse() {
        // Freshness (an old offline read) and the role no longer decide it when the daemon sent a word.
        let offline = PondFreshness.offline(line: "x", asOf: nil)
        let owner = PondConnectionInfo(state: .live, line: "Live")
        #expect(PondConnection.resolve(owner, freshness: offline, role: .member) == .live)
        let away = PondConnectionInfo(state: .ownerOffline, line: "Sibhi\u{2019}s Mac offline")
        let c = PondConnection.resolve(away, freshness: .live, role: .member)
        let h = PondDashboardHeader.make(.init(role: .member, isRemote: true, ownerName: "Sibhi", connection: c, connectionLine: away.line))
        #expect(h.stateLine == "Sibhi\u{2019}s Pond \u{00B7} Member \u{00B7} Sibhi\u{2019}s Mac offline")
    }

    @Test func thisMacsOwnTroubleReachingTheDaemonIsReconnecting() {
        let live = PondConnectionInfo(state: .live, line: "Live")
        #expect(PondConnection.resolve(live, freshness: .stale, role: .owner) == .reconnecting)
        #expect(PondConnection.resolve(live, freshness: .couldntRead, role: .member) == .reconnecting)
    }

    @Test func anOlderDaemonFallsBackToTheFreshnessReading() {
        #expect(PondConnection.resolve(nil, freshness: .offline(line: "x", asOf: nil), role: .member) == .ownerOffline)
        #expect(PondConnection.resolve(nil, freshness: .offline(line: "x", asOf: nil), role: .owner) == .reconnecting)
        #expect(PondConnection.resolve(nil, freshness: .live, role: .owner) == .live)
    }

    @Test func theOwnerSeesTheDaemonsSentenceInTheSharedLine() {
        let line = PondDashboardHeader.make(.init(role: .owner, people: 3, connection: .reconnecting, connectionLine: "Reconnecting\u{2026}")).stateLine
        #expect(line == "Shared with 3 people \u{00B7} Reconnecting\u{2026}")
    }

    @Test func theRoomHeaderEndsWithTheSameWord() {
        let c = PondConnectionInfo(state: .reconnecting, line: "Reconnecting\u{2026}")
        #expect(RoomDucks.subtitle(people: 2, ducks: 1, connection: c) == "2 people \u{00B7} 1 duck open \u{00B7} Reconnecting\u{2026}")
        #expect(RoomDucks.subtitle(people: 2, ducks: 1, connection: nil) == "2 people \u{00B7} 1 duck open")
    }
}

@Suite struct PondActionTrackerTests {
    @Test func nothingIsDoneUntilTheCloudConfirms() {
        var t = PondActionTracker()
        t.begin("remove:p:m", .remove, who: "Aarav")
        #expect(t.line("remove:p:m") == "Removing Aarav\u{2026}")
        #expect(t.isPending("remove:p:m"))
        // A confirm that was never begun draws nothing.
        t.confirm("remove:p:other")
        #expect(t.line("remove:p:other") == nil)
        t.confirm("remove:p:m")
        #expect(t.line("remove:p:m") == "Aarav was removed.")
        #expect(!t.isPending("remove:p:m"))
    }

    @Test func aFailureStaysWithOneSentenceAndTryAgain() {
        var t = PondActionTracker()
        t.begin("leave:p", .leave)
        #expect(t.line("leave:p") == "Leaving\u{2026}")
        t.fail("leave:p", reason: "Squeak couldn't confirm leaving with the cloud. You're still in the Pond. Try again.")
        #expect(t.offersTryAgain("leave:p"))
        #expect(t.failure("leave:p") == "Squeak couldn\u{2019}t leave the Pond: Squeak couldn't confirm leaving with the cloud. You're still in the Pond. Try again.")
        #expect(PondActionWords.tryAgain == "Try again")
        // Try again puts it back to pending in place.
        t.begin("leave:p", .leave)
        #expect(t.line("leave:p") == "Leaving\u{2026}")
        #expect(!t.offersTryAgain("leave:p"))
    }

    @Test func aFailureWithNoReasonStillSaysThePlainThing() {
        var t = PondActionTracker()
        t.begin("delete:p", .delete)
        t.fail("delete:p", reason: nil)
        #expect(t.line("delete:p") == "Squeak couldn\u{2019}t delete the Pond. The cloud didn\u{2019}t confirm it.")
        t.begin("invite:p", .invite)
        #expect(t.line("invite:p") == "Inviting\u{2026}")
        t.begin("withdraw:p:i", .withdraw)
        #expect(t.line("withdraw:p:i") == "Withdrawing\u{2026}")
        t.begin("resend:p:i", .resend)
        #expect(t.line("resend:p:i") == "Resending\u{2026}")
    }
}
