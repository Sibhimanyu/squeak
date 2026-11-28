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
        #expect(l[1].pondName == "A pond" && l[1].inviter == "A teammate" && l[1].state == .joined && l[1].expiresAt == nil)
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

    @Test func decodesTheNewStatesMembershipAndStale() throws {
        let json = #"{"stale":true,"invitations":[{"id":"a","pondId":"p","pondName":"O","inviter":"s***@x.co","role":"member","state":"declined","youAreMember":true,"expiresAt":0},{"id":"b","pondId":"p","pondName":"O","inviter":"Sam","state":"withdrawn"},{"id":"c","pondId":"p","pondName":"O","inviter":"Sam","state":"expired"}]}"#
        let l = try JSONDecoder().decode(PondInvitationList.self, from: Data(json.utf8))
        #expect(l.stale && l.invitations.map(\.state) == [.declined, .withdrawn, .expired])
        #expect(l.invitations[0].youAreMember && !l.invitations[1].youAreMember)
        #expect(PondInvitations.toAnswer(l.invitations).isEmpty)
        // An older host omits stale.
        #expect(try JSONDecoder().decode(PondInvitationList.self, from: Data(#"{"invitations":[]}"#.utf8)).stale == false)
    }

    @Test func staleLineIsQuiet() { #expect(PondInvitations.staleLine == "Couldn't refresh \u{00B7} Try again") }

    @Test func anAnswerReplacesOrDropsTheRow() {
        let a = PondInvitation(id: "a", pondId: "p1", pondName: "O", inviter: "S")
        let b = PondInvitation(id: "b", pondId: "p2", pondName: "B", inviter: "S")
        var joined = a; joined.state = .joined
        #expect(PondInvitations.applying(joined, to: [a, b]) == [joined, b])
        for gone in [PondInvitation.State.declined, .withdrawn, .expired] {
            var v = a; v.state = gone
            #expect(PondInvitations.applying(v, to: [a, b]) == [b])
        }
        #expect(PondInvitations.applying(b, to: [a]) == [a, b])
    }

    @Test func inviteSheetRowsGoIdleToInvitingToDone() {
        var r = InviteSheetRows()
        #expect(r.phase == .idle && !r.locked)
        r.begin(["a@x.co", "b@x.co", "c@x.co", "d@x.co"])
        #expect(r.locked && r.rows.map(\.text) == Array(repeating: "Inviting\u{2026}", count: 4))
        r.finish([
            PondInviteOutcome(email: "a@x.co", ok: true, invite: nil, message: nil, status: .invited),
            PondInviteOutcome(email: "B@x.co", ok: false, invite: nil, message: "Already a Member.", status: .alreadyMember),
            PondInviteOutcome(email: "c@x.co", ok: false, invite: nil, message: nil, status: .alreadyInvited),
        ])
        #expect(r.phase == .done && r.showsDone)
        #expect(r.rows.map(\.text) == ["Invited \u{2713}", "Already a Member.", "Already invited.", "Couldn\u{2019}t invite this address."])
        #expect(r.rows.map(\.failed) == [false, true, true, true] && r.invitedCount == 1)
    }

    @Test func aFailedCallUnlocksTheSheet() {
        var r = InviteSheetRows()
        r.begin(["a@x.co"]); r.fail()
        #expect(r.phase == .idle && !r.locked && r.rows.isEmpty)
    }

    @Test func peopleRowSaysEmailNotDeliveredOnlyForAPendingInvite() throws {
        let json = #"{"id":"i","email":"a@x.co","role":"member","state":"pending","invitedBy":"S","createdAt":1,"expiresAt":2,"settledAt":0,"emailFailed":true}"#
        let rec = try JSONDecoder().decode(PondInviteRecord.self, from: Data(json.utf8))
        #expect(rec.emailFailed)
        let row = PeopleSheetPlan.row(rec, now: Date(timeIntervalSince1970: 100))
        #expect(row.emailFailed && row.line == "Member \u{00B7} Email not delivered")
        var ok = rec; ok.emailFailed = false
        #expect(!PeopleSheetPlan.row(ok, now: Date(timeIntervalSince1970: 100)).emailFailed)
    }
}
