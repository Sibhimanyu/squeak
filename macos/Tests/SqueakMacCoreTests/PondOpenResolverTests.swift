import Foundation
import Testing

@testable import SqueakMacCore

@Suite("Pond open: which chat a click names, and a closed duck")
struct PondOpenResolverTests {
    private let known = ["s-1", "s-2", "host:with:colons"]

    @Test func anExactHostIdResolves() {
        #expect(PondOpenResolver.sessionId(for: "s-1", among: known) == "s-1")
    }

    @Test func aTurnIdResolvesToItsSession() {
        #expect(PondOpenResolver.sessionId(for: "s-2:turn-9", among: known) == "s-2")
    }

    @Test func aHostIdWithColonsIsNotPeeledWhenItIsKnown() {
        #expect(PondOpenResolver.sessionId(for: "host:with:colons", among: known) == "host:with:colons")
        #expect(PondOpenResolver.sessionId(for: "host:with:colons:t1", among: known) == "host:with:colons")
    }

    @Test func anUnknownIdResolvesToNothing() {
        #expect(PondOpenResolver.sessionId(for: "nope", among: known) == nil)
        #expect(PondOpenResolver.sessionId(for: "", among: known) == nil)
        #expect(PondOpenResolver.sessionId(for: "nope:s-1x", among: known) == nil)
    }

    @Test func everyTargetKindResolvesToItsDuckSession() {
        let targets: [PondOpenTarget] = [
            .duck("s-1"), .ducklings(duck: "s-2", labels: []), .ducklings(duck: "s-2:t3", labels: ["a"]),
            PondClick.target(duckling: RoomDuckling(label: "x"), of: "s-1"),
        ]
        let ids = targets.map { PondOpenResolver.plan($0, known: known, open: { _ in true }).sessionId }
        #expect(ids == ["s-1", "s-2", "s-2", "s-1"])
    }

    @Test func anClosedDuckStillOpensAndIsPutBackOpen() {
        let plan = PondOpenResolver.plan(.duck("s-1"), known: known, open: { $0 == "s-1" ? false : true })
        #expect(plan == .init(sessionId: "s-1", reopen: true))
        let on = PondOpenResolver.plan(.duck("s-2"), known: known, open: { _ in true })
        #expect(on.reopen == false)
        let unlisted = PondOpenResolver.plan(.duck("s-2"), known: known, open: { _ in nil })
        #expect(unlisted == .init(sessionId: "s-2", reopen: false))
    }

    @Test func aDuckWithNoChatYieldsANoteNotASilentNothing() {
        #expect(PondOpenResolver.plan(.duck("gone"), known: known, open: { _ in false }) == .init(sessionId: nil, reopen: false))
        #expect(PondOpenResolver.failureNote(name: "Pip") == "Couldn\u{2019}t open Pip")
        #expect(PondOpenResolver.failureNote(name: nil) == "Couldn\u{2019}t open that duck")
    }
}

@Suite("Duck roster click")
struct DuckRosterClickTests {
    private func row(_ json: String) throws -> RosterDuck {
        let d = try JSONDecoder().decode(PondDuck.self, from: Data(json.utf8))
        return RoomRoster.row(d)
    }

    @Test func duckWithCurrentSessionOpensIt() throws {
        let r = try row(#"{"id":"d1","name":"Pip","currentSessionId":"s-1","place":{"kind":"stream","workspaceId":"w","branch":"b"},"open":true}"#)
        #expect(RoomRoster.click(r) == .open(sessionId: "s-1"))
        #expect(RoomRoster.opening(r, known: ["s-1", "s-2"]) == .open(sessionId: "s-1"))
    }

    @Test func duckWithoutSessionIsNoJob() throws {
        let r = try row(#"{"id":"d1","name":"Pip"}"#)
        #expect(RoomRoster.opening(r, known: ["s-1"]) == .noJob(RoomRoster.noJobLine))
    }

    @Test func unknownChatFailsLoudly() throws {
        let r = try row(#"{"id":"d1","name":"Pip","currentSessionId":"gone"}"#)
        #expect(RoomRoster.opening(r, known: ["s-1"]) == .failed("Couldn\u{2019}t open Pip"))
    }
}

/// The room speaks the host's bare chat id; the app keys Squeak chats as "squeak-native:<id>" (the 2.30.0 "Couldn't open" bug).
@Test func roomIdsMatchPrefixedAppKeys() {
    let appKeys = ["squeak-native:a9fef7c6-9f11-42ac-a529-e374270661a8", "claude-terminal:x"]
    let bare = appKeys.map { $0.hasPrefix(NativeAdapter.keyPrefix) ? String($0.dropFirst(NativeAdapter.keyPrefix.count)) : $0 }
    #expect(PondOpenResolver.sessionId(for: "a9fef7c6-9f11-42ac-a529-e374270661a8", among: bare) == "a9fef7c6-9f11-42ac-a529-e374270661a8")
    #expect(PondOpenResolver.sessionId(for: "a9fef7c6-9f11-42ac-a529-e374270661a8", among: appKeys) == nil)
}
