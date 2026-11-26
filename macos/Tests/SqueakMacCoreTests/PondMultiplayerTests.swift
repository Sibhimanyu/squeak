import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct PondMultiplayerTests {
    private func member(_ json: String) throws -> FlockMember { try JSONDecoder().decode(FlockMember.self, from: Data(json.utf8)) }

    @Test func thereIsNoPerMemberSwitchAnOlderHostsFieldIsIgnoredAndMemberStartIsAsking() throws {
        // A host that still writes canStartTasks (or the old caps and `muted`) changes nothing: a Member is a Member.
        let m = try member(#"{"id":"m","role":"member","canStartTasks":true,"muted":true,"caps":{"message":true,"start":true}}"#)
        #expect(m.role == .member && m.caps?.start == true)
        // Start for a Member asks the Owner's Mac (the Duck then waits for approval); a Viewer has no button.
        #expect(PondChrome(access: .remote, ownerName: "Sibhi", canStart: true).start == .askOwner(label: "Ask Sibhi\u{2019}s Mac to start"))
        #expect(PondChrome(access: .remote, ownerName: "Sibhi", canStart: false).start == .hidden)
    }

    @Test func theWaitingDucksOnThePondViewDecodeForTheOwnerAndTheMember() throws {
        let json = #"{"pond":{"id":"p","name":"P"},"starts":[{"requestId":"r1","memberId":"a","name":"Asha","title":"Login bug","text":"Fix it","mine":false},{"requestId":"r2"}]}"#
        let d = try JSONDecoder().decode(PondDetail.self, from: Data(json.utf8))
        #expect(d.starts.map(\.requestId) == ["r1", "r2"])
        #expect(d.starts[0] == PondPendingStart(requestId: "r1", memberId: "a", name: "Asha", title: "Login bug", text: "Fix it", mine: false))
        // An older host sends none.
        let old = try JSONDecoder().decode(PondDetail.self, from: Data(#"{"pond":{"id":"p","name":"P"}}"#.utf8))
        #expect(old.starts.isEmpty)
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
