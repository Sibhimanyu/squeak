import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct PondMultiplayerTests {
    private func member(_ json: String) throws -> FlockMember { try JSONDecoder().decode(FlockMember.self, from: Data(json.utf8)) }

    @Test func presetsAreReadFromTheHostsSwitches() throws {
        let collab = try member(#"{"id":"m","role":"member","caps":{"see":true,"diffs":true,"message":true,"answer":true,"start":true}}"#)
        #expect(PondPresets.current(collab) == "collaborator")
        let plain = try member(#"{"id":"m","role":"member","caps":{"start":false}}"#)
        #expect(PondPresets.current(plain) == "member")
        let muted = try member(#"{"id":"m","role":"member","muted":true,"caps":{"message":false,"answer":false,"start":false}}"#)
        #expect(PondPresets.current(muted) == "custom" && muted.muted)
        #expect(PondPresets.current(try member(#"{"id":"m","role":"viewer"}"#)) == "viewer")
        #expect(PondPresets.value(plain, "start") == false)
    }

    @Test func aRestrictedComposerSaysWhyAndStartersAreNeverRestricted() {
        let off = PondCaps(message: false)
        let a = ThreadAccess(role: .member, starter: "s", me: "m", starterName: "Sibhi", caps: off)
        #expect(a.composer(working: false) == .watchOnly(line: "The owner has turned off messaging for you in this pond."))
        let locked = ThreadAccess(role: .member, starter: "s", me: "m", starterName: "Sibhi", locked: true)
        #expect(locked.composer(working: false) == .watchOnly(line: "This duck is read-only: its starter locked it."))
        #expect(ThreadAccess(role: .member, starter: "s", me: "m", starterName: "S", locked: true, allow: ["m"]).restriction == nil)
        #expect(ThreadAccess(role: .member, starter: "s", me: "m", starterName: "S", locked: true, allow: ["m"], deny: ["m"]).restriction != nil)
        #expect(ThreadAccess(role: .owner, starter: "m", me: "m", starterName: "Me", caps: off, locked: true).restriction == nil)
        let noAnswer = ThreadAccess(role: .member, starter: "s", me: "m", starterName: "S", caps: PondCaps(answer: false))
        #expect(!noAnswer.canAnswer && noAnswer.gate(.message).enabled)
    }

    @Test func aMembersOwnThreadIsMarkedPoweredByTheirMac() throws {
        let t = try JSONDecoder().decode(PondThread.self, from: Data(#"{"id":"t","title":"X","mode":"own","nest":"Aarav-mac","locked":true}"#.utf8))
        #expect(t.mode == .own && t.locked)
        #expect(PondPresets.poweredBy(nest: "Aarav-mac") == "Powered by Aarav-mac \u{00B7} Flotilla")
        var row = PondChatRow(id: "1", title: "T", state: .working, local: nil, pondThread: "t", nest: "Aarav-mac", people: [])
        row.poweredBy = PondPresets.poweredBy(nest: "Aarav-mac")
        #expect(row.visibility == "Powered by Aarav-mac \u{00B7} Flotilla")
    }
}
