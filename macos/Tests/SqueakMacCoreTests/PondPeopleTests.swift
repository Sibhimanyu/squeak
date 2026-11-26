import Foundation
import Testing
@testable import SqueakMacCore

// People and remote: the Invite sheet's tokens and refusals, the People sheet's rows, the Dashboard's avatars. Every sentence
// here is drawn from docs/mocks/2026-11-26/pond-dashboard (invite-sheet, people-sheet).

private let now = Date(timeIntervalSince1970: 1_800_000_000)
private func ms(_ ago: TimeInterval) -> Int { Int((now.timeIntervalSince1970 - ago) * 1000) }
private let hour: TimeInterval = 3600, day: TimeInterval = 86400

private func invite(_ id: String, _ email: String, _ state: PondInviteRecord.State, role: PondRole = .member,
                    created: TimeInterval = 3 * 86400, settled: TimeInterval? = nil) -> PondInviteRecord {
    PondInviteRecord(id: id, email: email, role: role, state: state, invitedBy: "Sibhi", createdAt: ms(created),
                     expiresAt: ms(created) + 7 * 86400_000, settledAt: settled.map { ms($0) } ?? 0)
}

private func person(_ id: String, _ name: String, _ role: PondRole, online: Bool = true, seen: TimeInterval? = nil, you: Bool = false) -> PondPerson {
    PondPerson(id: id, name: name, email: "\(name.lowercased())@x.app", role: role, online: online, lastSeenAt: seen.map { ms($0) }, you: you)
}

@Suite struct PondPeopleDecodingTests {
    @Test func peopleDecodeFromTheHostsShape() throws {
        let json = #"""
        {"cap":10,"members":[{"id":"m1","name":"Sibhi","email":"s@x.app","role":"owner","online":true,"lastSeenAt":null,"you":true},
        {"id":"m2","name":"Dev","email":"d@x.app","role":"viewer","online":false,"lastSeenAt":1700000000000,"you":false}],
        "invites":[{"id":"i1","email":"m@y.co","role":"member","state":"pending","invitedBy":"Sibhi","createdAt":1,"expiresAt":2,"settledAt":0},
        {"id":"i2","email":"z@y.co","role":"member","state":"someday","invitedBy":"Sibhi","createdAt":1,"expiresAt":2,"settledAt":0}]}
        """#
        let p = try JSONDecoder().decode(PondPeople.self, from: Data(json.utf8))
        #expect(p.cap == 10 && p.members.count == 2 && p.members[1].lastSeenAt == 1_700_000_000_000)
        #expect(p.members[0].you && p.members[0].role == .owner)
        // An invite in a state this app does not know is skipped, never drawn wrongly.
        #expect(p.invites.map(\.id) == ["i1"])
    }

    @Test func inviteResultsDecodeBothKinds() throws {
        let json = #"""
        {"results":[{"email":"a@x.co","ok":true,"invite":{"id":"i","email":"a@x.co","role":"viewer","state":"pending","invitedBy":"S","createdAt":1,"expiresAt":2,"settledAt":0}},
        {"email":"b@x.co","ok":false,"message":"Already a Member."}]}
        """#
        let r = try JSONDecoder().decode(PondInviteResults.self, from: Data(json.utf8))
        #expect(r.results.count == 2)
        #expect(r.results[0].ok && r.results[0].invite?.role == .viewer)
        #expect(!r.results[1].ok && r.results[1].message == "Already a Member.")
    }
}

@Suite struct InviteSheetPlanTests {
    @Test func tokensParseSplitLowercaseTrimAndDedupe() {
        var p = InviteSheetPlan(used: 3)
        p.add("Maya@Studio.co, priya@studio.co\n  maya@studio.co ;  bad")
        #expect(p.tokens.map(\.address) == ["maya@studio.co", "priya@studio.co", "bad"])
        #expect(p.tokens.map(\.valid) == [true, true, false])
        #expect(p.sendable == ["maya@studio.co", "priya@studio.co"])
    }

    @Test func roleDefaultsToMemberViewerSecond() {
        let p = InviteSheetPlan(used: 1)
        #expect(p.role == .member)
        #expect(InviteSheetPlan.roles == [.member, .viewer])
    }

    @Test func sendNeedsAtLeastOneValidAddress() {
        var p = InviteSheetPlan(used: 1)
        #expect(!p.canSend)
        p.add("nope")
        #expect(!p.canSend)
        #expect(p.invalidLine == "\u{201C}nope\u{201D} doesn\u{2019}t look like an email address.")
        p.add("a@b.co")
        #expect(p.canSend && p.sendTitle == "Send invite")
        p.add("c@d.co")
        #expect(p.sendTitle == "Send 2 invites")
    }

    @Test func placesLineCountsWhatIsUsedAndWhatTheseAdd() {
        var p = InviteSheetPlan(used: 4)
        #expect(p.placesLine == "4 of 10 places used")
        p.add("a@b.co c@d.co")
        #expect(p.placesLine == "4 of 10 places used, 2 more with these")
    }

    @Test func overTheCapCannotSend() {
        var p = InviteSheetPlan(used: 9)
        p.add("a@b.co c@d.co")
        #expect(!p.canSend)
        #expect(p.capLine == "Only 1 place is left. Remove an address to send.")
    }

    @Test func sentTokensLeaveAndRefusedStayWithTheirSentence() {
        var p = InviteSheetPlan(used: 4)
        p.add("maya@studio.co priya@studio.co asha@greenroom.app")
        p.apply([
            PondInviteOutcome(email: "maya@studio.co", ok: true, invite: invite("1", "maya@studio.co", .pending), message: nil),
            PondInviteOutcome(email: "priya@studio.co", ok: true, invite: invite("2", "priya@studio.co", .pending), message: nil),
            PondInviteOutcome(email: "asha@greenroom.app", ok: false, invite: nil, message: "Already a Member."),
        ])
        #expect(p.tokens.map(\.address) == ["asha@greenroom.app"])
        #expect(p.tokens[0].refusal == "Already a Member.")
        #expect(p.refusalLine == "asha@greenroom.app: Already a Member.")
        #expect(p.sentCount == 2)
        // A refused token is not sent again until it is removed.
        #expect(!p.canSend)
        p.remove("asha@greenroom.app")
        #expect(p.tokens.isEmpty)
    }

    @Test func allSentMeansDone() {
        var p = InviteSheetPlan(used: 1)
        p.add("a@b.co")
        p.apply([PondInviteOutcome(email: "a@b.co", ok: true, invite: nil, message: nil)])
        #expect(p.tokens.isEmpty && p.isDone)
    }

    @Test func refusalOnAnotherAddressLeavesTheRestSendable() {
        var p = InviteSheetPlan(used: 4)
        p.add("a@b.co c@d.co")
        p.apply([PondInviteOutcome(email: "a@b.co", ok: false, invite: nil, message: "Already invited.")])
        #expect(p.sendable == ["c@d.co"])
        #expect(p.refusalLine == "a@b.co: Already invited. Remove it to send the rest.")
    }
}

@Suite struct PeopleSheetPlanTests {
    private func plan(_ members: [PondPerson], _ invites: [PondInviteRecord] = []) -> PeopleSheetPlan {
        PeopleSheetPlan.make(PondPeople(cap: 10, members: members, invites: invites), now: now)
    }
    private let owner = person("o", "Sibhi", .owner, you: true)

    @Test func ownerSeesMembersWithTextPresenceAndRoleChoices() {
        let p = plan([owner, person("a", "Asha", .member), person("d", "Dev", .viewer, online: false, seen: 2 * hour)])
        #expect(p.members.map(\.name) == ["Sibhi", "Asha", "Dev"])
        #expect(p.members[0].seen == "online" && p.members[0].roleChoices.isEmpty && !p.members[0].canRemove)
        #expect(p.members[1].roleChoices == [.member, .viewer] && p.members[1].canRemove)
        #expect(p.members[2].seen == "last seen 2 h ago" && p.members[2].role == .viewer)
        #expect(p.members[1].email == "asha@x.app")
    }

    @Test func aMemberHasNoRemoveRoleMenuOrInviteActions() {
        let me = person("a", "Asha", .member, you: true)
        let p = plan([person("o", "Sibhi", .owner), me, person("d", "Dev", .viewer)], [invite("1", "m@y.co", .pending)])
        #expect(p.members.allSatisfy { !$0.canRemove && $0.roleChoices.isEmpty })
        #expect(p.invites.isEmpty)
        #expect(!p.canInvite)
    }

    @Test func ownerCannotBeRemovedAndNeverSelf() {
        let p = plan([owner, person("a", "Asha", .member)])
        #expect(p.members.filter(\.canRemove).map(\.id) == ["a"])
    }

    @Test func aConnectingPersonSaysSoAndHasNoRoleMenuOrRemove() {
        let c = PondPerson(id: "acct:u9", name: "Wren", email: "wren@x.app", role: .member, online: true, lastSeenAt: nil, you: false, connecting: true)
        let p = plan([owner, c])
        #expect(p.members[1].seen == "Connecting\u{2026}")
        #expect(p.members[1].roleChoices.isEmpty && !p.members[1].canRemove && p.members[1].connecting)
    }

    @Test func connectingDecodes() throws {
        let json = #"{"cap":10,"members":[{"id":"acct:u9","name":"Wren","email":"w@x.app","role":"member","online":false,"connecting":true,"you":false}],"invites":[]}"#
        let p = try JSONDecoder().decode(PondPeople.self, from: Data(json.utf8))
        #expect(p.members[0].connecting)
    }

    @Test func anInviteRowTitlesByAccountNameWithTheEmailBeneath() throws {
        let json = #"{"id":"i","email":"m@y.co","role":"member","state":"pending","invitedBy":"S","createdAt":1,"expiresAt":2,"settledAt":0,"name":"Maya","userId":"u1"}"#
        let rec = try JSONDecoder().decode(PondInviteRecord.self, from: Data(json.utf8))
        #expect(rec.name == "Maya" && rec.userId == "u1")
        let named = plan([owner], [rec]).invites[0]
        #expect(named.title == "Maya" && named.subtitle == "m@y.co")
        let bare = plan([owner], [invite("b", "b@y.co", .pending)]).invites[0]
        #expect(bare.title == "b@y.co" && bare.subtitle == nil)
    }

    @Test func memberWithNoReadingShowsNoSeenText() {
        let p = plan([owner, person("a", "Asha", .member, online: false)])
        #expect(p.members[1].seen == nil)
    }

    @Test func everyInviteStateDrawsItsTextAndActions() {
        let p = plan([owner], [
            invite("p", "maya@studio.co", .pending, created: 3 * day),
            invite("d", "tom@acme.dev", .declined, settled: 2 * hour),
            invite("e", "lena@oldmail.com", .expired, role: .viewer, created: 8 * day, settled: 1 * day),
            invite("w", "wes@x.co", .withdrawn, settled: 1 * day),
        ])
        let by = Dictionary(uniqueKeysWithValues: p.invites.map { ($0.id, $0) })
        #expect(by["p"]?.stateText == "Invited \u{00B7} 3 days ago")
        #expect(by["p"]?.actions == [.resend, .withdraw])
        #expect(by["d"]?.stateText == "Declined \u{00B7} 2 h ago")
        #expect(by["d"]?.actions == [.inviteAgain])
        #expect(by["e"]?.stateText == "Expired")
        #expect(by["e"]?.actions == [.inviteAgain])
        #expect(by["w"]?.stateText == "Withdrawn \u{00B7} 1 d ago")
        #expect(by["w"]?.actions == [.inviteAgain])
        #expect(by["e"]?.line == "Viewer \u{00B7} Expired")
        #expect(by["p"]?.line == "Member \u{00B7} Invited \u{00B7} 3 days ago")
        #expect(p.invites.first?.id == "p")   // pending first
    }

    @Test func joinedInvitesAreNotDrawnAndOldFinishedOnesAreDropped() {
        let p = plan([owner], [
            invite("j", "a@y.co", .joined, settled: 1 * hour),
            invite("old", "b@y.co", .declined, settled: 8 * day),
            invite("edge", "c@y.co", .withdrawn, settled: 6 * day),
        ])
        #expect(p.invites.map(\.id) == ["edge"])
    }

    @Test func subtitleCountsPlacesNotFinishedInvites() {
        let p = plan([owner, person("a", "Asha", .member), person("d", "Dev", .viewer)],
                     [invite("p", "m@y.co", .pending), invite("d", "t@y.co", .declined, settled: hour), invite("e", "l@y.co", .expired, settled: day)])
        #expect(p.subtitle == "4 of 10 places used: 3 people and 1 pending invite")
        #expect(plan([owner]).subtitle == "1 of 10 places used: 1 person")
        let two = plan([owner], [invite("p", "m@y.co", .pending), invite("q", "n@y.co", .pending)])
        #expect(two.subtitle == "3 of 10 places used: 1 person and 2 pending invites")
    }

    @Test func ownerCanInviteWhileThereIsRoom() {
        #expect(plan([owner]).canInvite)
        let full = (0..<9).map { person("m\($0)", "M\($0)", .member) }
        #expect(!plan([owner] + full + [person("x", "X", .member)]).canInvite)
    }
}

@Suite struct PondAvatarRowPeopleTests {
    @Test func membersThenOutlinedPendingInvitesOnly() {
        let people = PondPeople(cap: 10, members: [person("a", "Asha", .member), person("o", "Sibhi", .owner, you: true)], invites: [
            invite("p", "maya@studio.co", .pending), invite("d", "t@y.co", .declined, settled: hour), invite("j", "j@y.co", .joined, settled: hour),
        ])
        let row = PondAvatarRow.build(people)
        #expect(row.items == [.person(id: "o", name: "Sibhi", you: true), .person(id: "a", name: "Asha", you: false), .pending(id: "p", initial: "M")])
        #expect(row.more == 0)
    }

    @Test func capsWithMore() {
        let members = (0..<7).map { person("m\($0)", "M\($0)", .member, you: $0 == 0) }
        let row = PondAvatarRow.build(PondPeople(cap: 10, members: members, invites: [invite("p", "a@y.co", .pending)]))
        #expect(row.items.count == PondAvatarRow.cap && row.more == 3)
    }
}
