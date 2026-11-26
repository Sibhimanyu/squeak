import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct PondMultiplayerTests {
    private func member(_ json: String) throws -> FlockMember { try JSONDecoder().decode(FlockMember.self, from: Data(json.utf8)) }

    @Test func aMembersOneSwitchIsReadFromTheHostAndDefaultsOff() throws {
        #expect(try member(#"{"id":"m","role":"member","canStartTasks":true}"#).canStartTasks)
        #expect(try member(#"{"id":"m","role":"member","canStartTasks":false}"#).canStartTasks == false)
        // An older host (caps only, no switch) reads as off; the old switches and `muted` are ignored.
        let old = try member(#"{"id":"m","role":"member","muted":true,"caps":{"message":false,"start":true}}"#)
        #expect(old.canStartTasks == false)
    }

    @Test func onlyTheOwnerSeesTheSwitchAndOnlyForAnotherMember() throws {
        let aarav = try member(#"{"id":"a","role":"member"}"#)
        let vera = try member(#"{"id":"v","role":"viewer"}"#)
        let owner = try member(#"{"id":"o","role":"owner","you":true}"#)
        #expect(PondRoles.offersStartTasks(aarav, viewerIsOwner: true))
        #expect(!PondRoles.offersStartTasks(aarav, viewerIsOwner: false))
        #expect(!PondRoles.offersStartTasks(vera, viewerIsOwner: true))
        #expect(!PondRoles.offersStartTasks(owner, viewerIsOwner: true))
        #expect(PondRoles.startTasksTitle == "Can start Tasks")
    }

    @Test func aViewerCannotMessageAndTheOwnerChoosesOnlyBetweenViewerAndMember() throws {
        let a = ThreadAccess(role: .viewer, starter: "s", me: "m", starterName: "Sibhi")
        #expect(a.composer(working: false) == .watchOnly(line: ThreadAccess.watchLine))
        #expect(ThreadAccess(role: .member, starter: "s", me: "m", starterName: "Sibhi").composer(working: false) == .open(placeholder: "Message"))
        #expect(ThreadAccess(role: .member, starter: "s", me: "m", starterName: "S").canAnswer)
        #expect(!ThreadAccess(role: .viewer, starter: "s", me: "m", starterName: "S").canAnswer)
        #expect(PondMembers.rolesToChangeTo(try member(#"{"id":"a","role":"member"}"#)) == [.viewer])
        #expect(PondMembers.rolesToChangeTo(try member(#"{"id":"v","role":"viewer"}"#)) == [.member])
    }

    @Test func aMembersOwnThreadIsMarkedPoweredByTheirMac() throws {
        let t = try JSONDecoder().decode(PondThread.self, from: Data(#"{"id":"t","title":"X","mode":"own","nest":"Aarav-mac","locked":true}"#.utf8))
        #expect(t.mode == .own)
        #expect(PondPoweredBy.line(nest: "Aarav-mac") == "Powered by Aarav-mac \u{00B7} Flotilla")
        var row = PondChatRow(id: "1", title: "T", state: .working, local: nil, pondThread: "t", nest: "Aarav-mac", people: [])
        row.poweredBy = PondPoweredBy.line(nest: "Aarav-mac")
        #expect(row.visibility == "Powered by Aarav-mac \u{00B7} Flotilla")
    }
}
