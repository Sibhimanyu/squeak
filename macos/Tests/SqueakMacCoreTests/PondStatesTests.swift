import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct PondStatesTests {
    private func pond(_ json: String) throws -> PondSummary { try JSONDecoder().decode(PondSummary.self, from: Data(json.utf8)) }
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func decodesTheContractFieldsAndOldHostsToo() throws {
        let p = try pond(#"{"id":"a","name":"greenroom","status":"pending","requestedRole":"member","statusLine":"Waiting for Sibhi to approve you as a member.","ownerName":"Sibhi","offline":true,"asOf":1800000000000,"offlineLine":"Can't reach."}"#)
        #expect(p.state == .pending && p.ownerName == "Sibhi" && p.offline && p.asOf != nil && p.offlineLine == "Can't reach.")
        let old = try pond(#"{"id":"a","name":"x","status":"denied"}"#)
        #expect(old.state == .declined && old.isDeclined && old.isTerminal && !old.offline && old.statusLine == nil)
        #expect(try pond(#"{"id":"a","name":"x","status":"local"}"#).local)
        #expect(try pond(#"{"id":"a","name":"x"}"#).state == .active)
    }

    @Test func everyStateHasACardAndTerminalOnesCanBeRemoved() throws {
        for s in ["declined", "expired", "revoked", "removed"] {
            let c = try #require(PondStates.card(for: try pond(#"{"id":"a","name":"g","status":"\#(s)"}"#)))
            #expect(c.button == "Remove" && c.forgets && c.tone == .problem && !c.line.isEmpty)
        }
        let pending = try #require(PondStates.card(for: try pond(#"{"id":"a","name":"g","status":"pending","ownerName":"Sibhi","requestedRole":"viewer"}"#)))
        #expect(pending.line == "Waiting for Sibhi to approve you as a viewer." && pending.button == "Cancel request" && !pending.forgets)
        #expect(PondStates.card(for: try pond(#"{"id":"a","name":"g","status":"active"}"#)) == nil)
        let hostLine = try #require(PondStates.card(for: try pond(#"{"id":"a","name":"g","status":"declined","statusLine":"Sibhi declined your request."}"#)))
        #expect(hostLine.line == "Sibhi declined your request.")
        let local = try #require(PondStates.card(for: try pond(#"{"id":"a","name":"g","status":"local"}"#)))
        #expect(local.title == "Only on this Mac")
    }

    @Test func greyedRowsCoverWaitingAndEnded() throws {
        let list = try ["pending", "active", "removed", "local", "expired"].map { try pond(#"{"id":"\#($0)","name":"n\#($0)","status":"\#($0)"}"#) }
        #expect(PondJoinWaiting.rows(list).map(\.id) == ["pending", "removed", "expired"])
        #expect(PondStates.rowTitle(list[2]) == "nremoved \u{00B7} You were removed")
    }

    @Test func freshnessNeverDrawsAnEmptyPondAsReal() throws {
        let p = try pond(#"{"id":"a","name":"g"}"#)
        #expect(PondFreshness.of(detail: nil, pond: p, reading: true, failed: false) == .reading)
        #expect(PondFreshness.of(detail: nil, pond: p, reading: false, failed: true) == .couldntRead)
        let d = PondDetail(pond: p)
        #expect(PondFreshness.of(detail: d, pond: p, reading: true, failed: false) == .refreshing)
        #expect(PondFreshness.of(detail: d, pond: p, reading: false, failed: true) == .stale)
        #expect(PondFreshness.of(detail: d, pond: p, reading: false, failed: false) == .live)
        var off = p; off.offline = true; off.offlineLine = "Can't reach Squeak's cloud. Showing what was here at 10:42."; off.asOf = now
        let f = PondFreshness.of(detail: PondDetail(pond: off), pond: off, reading: false, failed: false)
        #expect(f.line == off.offlineLine && !f.canWrite && f.writesDisabledReason != nil)
        off.offlineLine = nil
        #expect(PondFreshness.of(detail: nil, pond: off, reading: false, failed: false).line?.hasPrefix("Can\u{2019}t reach Squeak\u{2019}s cloud. Showing what was here at") == true)
    }

    @Test func badgeAddsJoinsForOwnersOnly() throws {
        let p = PondSummary(id: "a", name: "g", role: .owner, needsYou: 1)
        let j = JoinRequest(id: "j", name: "Priya")
        #expect(PondBadge.count(pond: p, detail: PondDetail(pond: p, joins: [j], me: PondMe(id: "m", role: .owner))) == 2)
        let m = PondSummary(id: "a", name: "g", role: .member, needsYou: 1)
        #expect(PondBadge.count(pond: m, detail: PondDetail(pond: m, joins: [j], me: PondMe(id: "m", role: .member))) == 1)
        #expect(PondBadge.count(pond: PondSummary(id: "a", name: "g", status: "removed"), detail: nil) == 0)
    }

    @Test func joinCardsNameWhoIsAskingAndSayHowADecisionWent() {
        let web = JoinRequest(id: "j", name: "Priya", isWeb: true, verifiedEmail: "p@x.com")
        #expect(JoinCardText.source(web) == "From a web browser" && JoinCardText.email(web) == "p@x.com \u{00B7} Verified")
        #expect(JoinCardText.source(JoinRequest(id: "j", name: "P", nest: "Priya's MacBook")) == "From Priya's MacBook")
        let failed = JoinRequest(id: "j", name: "Priya", decisionState: "failed", decisionApprove: true, decisionError: "The pond can't be reached")
        let line = JoinCardText.decisionLine(failed, pressing: nil)
        #expect(line?.failed == true && line?.text == "Couldn\u{2019}t approve Priya: The pond can't be reached. Approve to try again.")
        #expect(JoinCardText.decisionLine(failed, pressing: true)?.text == "Approving\u{2026}")
        #expect(JoinCardText.decisionLine(JoinRequest(id: "j", name: "P"), pressing: nil) == nil)
    }

    @Test func inviteRowsShowEveryStateNewestFirst() {
        let list = [
            PondInviteEntry(id: "1", state: .pending, createdAt: now.addingTimeInterval(-3600), expiresAt: now.addingTimeInterval(7200), link: "https://x/join#c"),
            PondInviteEntry(id: "2", state: .accepted, createdAt: now.addingTimeInterval(-100), usedBy: "Priya"),
            PondInviteEntry(id: "3", role: .viewer, state: .declined, createdAt: now.addingTimeInterval(-200), usedBy: "Raj"),
            PondInviteEntry(id: "4", state: .revoked, createdAt: now.addingTimeInterval(-90_000)),
            PondInviteEntry(id: "5", state: .pending, createdAt: now.addingTimeInterval(-90_000), expiresAt: now.addingTimeInterval(-10)),
        ]
        let rows = PondInvites.rows(list, now: now)
        #expect(rows.map(\.id) == ["2", "3", "1", "4", "5"])
        #expect(rows[0].line == "Priya joined" && !rows[0].canRevoke)
        #expect(rows[1].title == "Viewer invite" && rows[1].line == "Raj was declined")
        #expect(rows[2].line == "Waiting for someone to use it \u{00B7} Expires in 2 h" && rows[2].canRevoke && rows[2].canCopy)
        #expect(rows[3].line == "Revoked" && !rows[3].recent)
        #expect(rows[4].line == "Expired" && !rows[4].canRevoke)
    }

    @Test func memberRowsAreHonestAboutPresence() {
        let m = FlockMember(id: "m", name: "Aarav", role: .member, nest: "Mac", online: false, nestName: "Aarav's MacBook", lastSeenAt: now.addingTimeInterval(-300))
        #expect(PondMembers.seen(m, presence: [], threads: [], pondOffline: false, now: now) == "Last seen 5 min ago")
        #expect(PondMembers.seen(m, presence: [PondPresenceEntry(member: "m")], threads: [], pondOffline: false, now: now) == "Online")
        #expect(PondMembers.seen(FlockMember(id: "z", name: "Z"), presence: [], threads: [], pondOffline: false, now: now) == nil)
        #expect(PondMembers.machine(m) == "Aarav's MacBook" && PondMembers.machine(FlockMember(id: "w", name: "W", client: "web")) == "Web")
        #expect(PondMembers.rolesToChangeTo(m) == [.viewer] && PondMembers.rolesToChangeTo(FlockMember(id: "me", name: "Me", role: .owner, you: true)).isEmpty)
        #expect(PondFlock.line(for: m, presence: [], threads: []).contains("Member"))
    }

    @Test func ripplesReadAsActorThenText() {
        func r(_ actor: String, _ name: String, _ text: String) -> RippleEntry { RippleEntry(id: "1", at: now, actor: actor, actorName: name, text: text) }
        #expect(PondRipples2.sentence(r("a", "Priya", "answered a question"), me: "m") == "Priya answered a question")
        #expect(PondRipples2.sentence(r("m", "Sibhi", "changed the pond key"), me: "m") == "You changed the pond key")
        #expect(PondRipples2.sentence(r("a", "Priya", "Priya joined"), me: "m") == "Priya joined")
        #expect(PondRipples2.sentence(r("", "", "A thread was shared"), me: "m") == "A thread was shared")
    }

    @Test func sentMessagesShowTheirStateAndSettleWhenTheTranscriptHasThem() {
        let o = PondOutgoing(text: "go on", sentAt: now, state: .queued)
        #expect(o.line(starter: "Aarav", now: now) == "Waiting for Aarav\u{2019}s Mac to pick it up.")
        #expect(o.line(starter: "Aarav", now: now.addingTimeInterval(100)) == "Aarav\u{2019}s Mac hasn\u{2019}t picked this up yet. It may be asleep.")
        #expect(PondOutbox.state(for: PondSendResult(state: .refused, line: "Viewers can read but not send.")) == .refused("Viewers can read but not send."))
        #expect(PondOutgoing(text: "x", sentAt: now, state: .refused("Nope")).line(starter: "", now: now) == "Nope")
        let delivered = ThreadEvent(seq: 1, kind: .user(by: "m", text: "go on"))
        let list = [o, PondOutgoing(text: "later", sentAt: now, state: .queued), PondOutgoing(text: "no", sentAt: now, state: .refused("x"))]
        #expect(PondOutbox.settle(list, events: [delivered], me: "m").map(\.text) == ["later", "no"])
    }

    @Test func threadRulesExplainWhoMaySendAndApprove() {
        #expect(PondThreadStatus.composerBlock(role: .viewer, asks: true, isStarter: false, starterName: "Aarav") == "You\u{2019}re a viewer: you can read but not send.")
        #expect(PondThreadStatus.composerBlock(role: .member, asks: false, isStarter: false, starterName: "Aarav") == "Only Aarav can message this thread while it runs without asking.")
        #expect(PondThreadStatus.composerBlock(role: .member, asks: false, isStarter: true, starterName: "Aarav") == nil)
        #expect(PondThreadStatus.composerBlock(role: .member, asks: nil, isStarter: false, starterName: "Aarav") == nil)
        #expect(PondThreadStatus.ownershipLine(starterName: "Aarav", isStarter: false) == "Approve and Stop stay with Aarav.")
        #expect(PondThreadStatus.ownershipLine(starterName: "Aarav", isStarter: true) == nil)
        #expect(!PondThreadStatus.canAnswer(role: .viewer) && PondThreadStatus.canAnswer(role: .member))
        #expect(PondThreadStatus.line(PondThread(id: "t", title: "T", stateLine: "Working on Aarav's Mac")) == "Working on Aarav's Mac")
        #expect(PondThreadStatus.line(PondThread(id: "t", title: "T", starterName: "Aarav", starterOnline: false)) == "Aarav\u{2019}s Mac is offline")
        #expect(PondThreadStatus.visibility(isPrivate: true) == "Private")
    }

    @Test func joinerNotificationsFollowTransitions() throws {
        func p(_ s: String) throws -> PondSummary { try pond(#"{"id":"a","name":"greenroom","status":"\#(s)","ownerName":"Sibhi"}"#) }
        let pending = try [p("pending")]
        #expect(PondNotes.joiner(old: pending, new: [try p("active")]).map(\.title) == ["You\u{2019}re in greenroom"])
        #expect(PondNotes.joiner(old: pending, new: [try p("declined")]).map(\.title) == ["Sibhi declined your request"])
        #expect(PondNotes.joiner(old: pending, new: [try p("expired")]).map(\.title) == ["This invite expired"])
        #expect(PondNotes.joiner(old: [try p("active")], new: [try p("removed")]).map(\.title) == ["You were removed from greenroom"])
        #expect(PondNotes.joiner(old: pending, new: pending).isEmpty)
        #expect(PondNotes.joiner(old: [], new: [try p("removed")]).isEmpty)
        #expect(PondNotes.joiner(old: pending, new: [try p("active")]).first?.pondId == "a")
    }

    @Test func ownerAndMemberNotifications() {
        let pond = PondSummary(id: "a", name: "greenroom", role: .owner)
        let me = FlockMember(id: "m", name: "Sibhi", role: .owner, you: true)
        let j = JoinRequest(id: "j1", name: "Priya", nest: "Priya's Mac")
        let new = PondDetail(pond: pond, members: [me], joins: [j], me: PondMe(id: "m", role: .owner))
        let notes = PondNotes.owner(pond: pond, old: nil, new: new, seen: [])
        #expect(notes.map(\.title) == ["Priya wants to join greenroom"])
        #expect(PondNotes.owner(pond: pond, old: nil, new: new, seen: ["j1"]).isEmpty)
        let priya = FlockMember(id: "p", name: "Priya", role: .member)
        let after = PondDetail(pond: pond, members: [me, priya], me: PondMe(id: "m", role: .owner))
        #expect(PondNotes.owner(pond: pond, old: new, new: after, seen: []).map(\.title) == ["Priya joined greenroom"])

        let mp = PondSummary(id: "a", name: "greenroom", role: .member)
        func d(_ state: String, _ line: String? = nil) -> PondDetail {
            PondDetail(pond: mp, members: [FlockMember(id: "me", name: "Me", you: true)], threads: [PondThread(id: "t", title: "Fix login", starter: "x", starterName: "Aarav", state: state, stateLine: line)], me: PondMe(id: "me", role: .member))
        }
        #expect(PondNotes.threads(pond: mp, old: d("working"), new: d("needs_you")).map(\.title) == ["Fix login needs you"])
        #expect(PondNotes.threads(pond: mp, old: d("working"), new: d("needs_you", "Waiting for Aarav to approve an edit")).isEmpty)
        #expect(PondNotes.threads(pond: mp, old: d("needs_you"), new: d("needs_you")).isEmpty)
    }

    @Test func joinedPondsGetASidebarRowEvenWithNoSessions() throws {
        let joined = PondSummary(id: "j", name: "Greenroom", projectId: nil)
        let mine = PondSummary(id: "m", name: "mine", projectId: "p1")
        #expect(PondSidebar.joinedNames([joined, mine], existing: ["mine"]) == ["Greenroom"])
        #expect(PondSidebar.joinedNames([joined], existing: ["greenroom"]).isEmpty)
        #expect(PondSidebar.tooltip(PondSummary(id: "l", name: "l", local: true)) == "Only on this Mac")
    }

    @Test func newDecodesAreOptionalAndStableOnToday() throws {
        let d = try JSONDecoder().decode(PondDetail.self, from: Data(#"{"pond":{"id":"a","name":"g"},"members":[{"id":"m","name":"A"}],"threads":[{"id":"t","title":"T"}],"holds":[{"requestId":"r","heldBy":"m","heldByName":"Aarav","until":1800000000000}]}"#.utf8))
        #expect(d.invites.isEmpty && d.threads[0].asks == nil && d.threads[0].stateLine == nil && d.members[0].lastSeenAt == nil)
        #expect(d.holds[0].byName == "Aarav" && d.holds[0].by == "m")
        let full = try JSONDecoder().decode(PondDetail.self, from: Data(#"{"pond":{"id":"a","name":"g","offline":true},"invites":[{"id":"i","role":"viewer","state":"accepted","usedBy":"Priya"}],"joins":[{"requestId":"j","name":"P","decision":{"state":"failed","line":"nope"}}]}"#.utf8))
        #expect(full.pond.offline && full.invites[0].usedBy == "Priya" && full.joins[0].decisionError == "nope")
        let r = try JSONDecoder().decode(PondSendResult.self, from: Data(#"{"state":"refused","line":"Viewers can read but not send."}"#.utf8))
        #expect(r.state == .refused && r.line == "Viewers can read but not send.")
        #expect(try JSONDecoder().decode(PondSendResult.self, from: Data(#"{"queued":true}"#.utf8)).state == .queued)
    }
}
