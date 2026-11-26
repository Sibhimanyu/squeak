import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct PondInvitationTests {
    private func list(_ json: String) throws -> [PondInvitation] {
        struct R: Decodable { var invitations: [Failable<PondInvitation>] }
        return try JSONDecoder().decode(R.self, from: Data(json.utf8)).invitations.compactMap(\.value)
    }

    @Test func decodesTheDaemonsInvitationsAndSkipsABrokenOne() throws {
        let l = try list(#"{"invitations":[{"id":"i1","pondId":"p1","pondName":"Orchard","inviter":"Sibhi","role":"viewer","state":"pending","expiresAt":1800000000000},{"nope":1},{"id":"i2","pondId":"p2","pondName":"","inviter":"","role":"member","state":"joined","expiresAt":0}]}"#)
        #expect(l.map(\.id) == ["i1", "i2"])
        #expect(l[0].role == .viewer && l[0].state == .pending && l[0].expiresAt != nil)
        #expect(l[1].pondName == "A pond" && l[1].inviter == "Someone" && l[1].state == .joined && l[1].expiresAt == nil)
        #expect(PondInvitations.toAnswer(l).map(\.id) == ["i1"])
        #expect(PondInvitations.line(l[0]) == "Sibhi invited you to Orchard as a viewer.")
    }

    @Test func oneNotificationPerInviteEverEvenAcrossReads() {
        let a = PondInvitation(id: "i1", pondId: "p1", pondName: "Orchard", inviter: "Sibhi")
        let joined = PondInvitation(id: "i2", pondId: "p2", pondName: "Barn", inviter: "Sam", state: .joined)
        let first = PondInvitations.notes(list: [a, joined], seen: [])
        #expect(first.notes.map(\.id) == ["pond-invite-i1"] && first.notes[0].kind == .invited && first.notes[0].pondId == "p1")
        // The same list again, and the invite gone then back: nothing more.
        #expect(PondInvitations.notes(list: [a], seen: first.seen).notes.isEmpty)
        let gone = PondInvitations.notes(list: [], seen: first.seen)
        #expect(PondInvitations.notes(list: [a], seen: gone.seen).notes.isEmpty)
        let b = PondInvitation(id: "i3", pondId: "p3", pondName: "Pier", inviter: "Ann")
        #expect(PondInvitations.notes(list: [a, b], seen: first.seen).notes.map(\.id) == ["pond-invite-i3"])
    }

    @Test func connectingPondIsAGreyedRowAndNotificationsSayYoureIn() throws {
        let connecting = PondSummary(id: "p1", name: "Orchard", status: "pending", ownerName: "Sibhi", connecting: true)
        #expect(PondStates.greyedRows([connecting]).map(\.id) == ["p1"])
        #expect(PondStates.card(for: connecting)?.title == "Connecting" && PondStates.card(for: connecting)?.button == nil)
        var active = connecting; active.status = "active"; active.connecting = false
        let notes = PondNotes.joiner(old: [connecting], new: [active])
        #expect(notes.map(\.kind) == [.approved] && notes[0].title == "You\u{2019}re in Orchard")
    }

    @Test func aSignedInInviteeWithNoPondOfTheirOwnLandsOnInvitations() {
        let pending = PondInvitation(id: "i1", pondId: "p1", pondName: "Orchard", inviter: "Sibhi")
        let joined = PondInvitation(id: "i2", pondId: "p2", pondName: "Barn", inviter: "Sam", state: .joined)
        func entry(_ list: [PondInvitation]) -> SetupEntry {
            SetupFlow(SetupFlowFacts(setup: SetupFacts(service: .notInstalled), signedIn: true,
                                     pendingInvitations: PondInvitations.toAnswer(list).count, ownPonds: 0, joinedPonds: 0),
                      progress: SetupProgress()).entry
        }
        #expect(entry([pending]) == .invitations)
        // A joined one is no longer waiting on an answer; nothing is left to answer.
        #expect(entry([joined]) != .invitations)
    }
}
