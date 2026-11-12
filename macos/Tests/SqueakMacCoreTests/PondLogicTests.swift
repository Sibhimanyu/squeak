import Foundation
import Testing
@testable import SqueakMacCore

private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

private func thread(_ id: String, _ state: String, _ age: Double, title: String? = nil, starter: String = "m1") -> PondThread {
    PondThread(id: id, title: title ?? id, starter: starter, starterName: "Aarav", state: state, updatedAt: t0.addingTimeInterval(-age))
}

@Suite("Pond home")
struct PondLogicTests {
    @Test func threadsGroupNeedsYouWorkingDoneNewestFirst() {
        let detail = PondDetail(
            pond: PondSummary(id: "p", name: "O"),
            members: [FlockMember(id: "m1", name: "Aarav", you: true)],
            threads: [thread("a", "idle", 10), thread("b", "working", 5), thread("c", "needs_user_input", 50), thread("d", "error", 1), thread("e", "working", 60), thread("f", "blocked", 2)])
        let s = PondHomeThreads.sections(PondHomeThreads.fromPond(detail, localKey: { _ in nil }))
        #expect(s.map(\.group) == [.needsYou, .working, .done])
        #expect(s[0].threads.map(\.id) == ["f", "c"])
        #expect(s[1].threads.map(\.id) == ["b", "e"])
        // A failed thread is Done, not Needs you: nothing is invented as waiting.
        #expect(s[2].threads.map(\.id) == ["d", "a"])
    }

    @Test func aGroupWithNothingIsLeftOutAndTiesGoByTitle() {
        let detail = PondDetail(pond: PondSummary(id: "p", name: "O"), threads: [thread("1", "working", 0, title: "Beta"), thread("2", "working", 0, title: "Alpha")])
        let s = PondHomeThreads.sections(PondHomeThreads.fromPond(detail, localKey: { _ in nil }))
        #expect(s.map(\.group) == [.working])
        #expect(s[0].threads.map(\.title) == ["Alpha", "Beta"])
        #expect(PondHomeThreads.sections([]).isEmpty)
    }

    @Test func aThreadYouStartedOpensYourLocalChatAndAnotherMembersDoesNot() {
        let key = SessionKey(provider: "squeak", hostSessionId: "s1")
        var mine = thread("t1", "idle", 0, starter: "m1"); mine.sessionId = "s1"
        var theirs = thread("t2", "idle", 0, starter: "m2"); theirs.sessionId = "s1"
        let detail = PondDetail(pond: PondSummary(id: "p", name: "O"), members: [FlockMember(id: "m1", name: "Me", you: true)], threads: [mine, theirs])
        let rows = PondHomeThreads.fromPond(detail, localKey: { $0 == "s1" ? key : nil })
        #expect(rows.first { $0.id == "t1" }?.local == key)
        #expect(rows.first { $0.id == "t2" }?.local == nil)
    }

    @Test func localThreadsMapTheirSessionState() {
        let a = SessionKey(provider: "squeak", hostSessionId: "a"), b = SessionKey(provider: "squeak", hostSessionId: "b")
        let rows = PondHomeThreads.fromLocal(
            [PondThreadFact(key: a, title: "One", state: .blocked, lastActivityAt: t0), PondThreadFact(key: b, title: "", state: .finished, lastActivityAt: nil)],
            agents: [a: "claude"], person: "Me")
        #expect(rows.map(\.state) == [.needsYou, .finished])
        #expect(rows[1].title == "Untitled thread" && rows[0].agent == "claude" && rows[0].starterName == "Me" && rows[0].pondThread == nil)
    }

    @Test func joinRequestDecodesWithAndWithoutVerifiedIdentity() throws {
        let old = try JSONDecoder().decode(JoinRequest.self, from: Data(#"{"requestId":"j1","name":"Priya","client":"web"}"#.utf8))
        #expect(old.verifiedEmail == nil && old.verifiedName == nil)
        #expect(old.displayName == "Priya" && old.accessibilityLabel == "Priya wants to join")
        let new = try JSONDecoder().decode(JoinRequest.self, from: Data(#"{"requestId":"j2","name":"p","client":"web","verifiedEmail":"priya@gmail.com","verifiedName":"Priya"}"#.utf8))
        #expect(new.verifiedEmail == "priya@gmail.com" && new.verifiedName == "Priya")
        #expect(new.accessibilityLabel == "Priya, priya@gmail.com, verified, wants to join")
    }

    @Test func needsYouCountsJoinRequestsOnlyForAnOwner() {
        var d = PondDetail(
            pond: PondSummary(id: "p", name: "O", role: .owner), members: [FlockMember(id: "m", name: "Me", role: .owner, you: true)],
            threads: [thread("a", "blocked", 0), thread("b", "working", 0)], joins: [JoinRequest(id: "j", name: "Dev")])
        #expect(PondHomeThreads.needsYouCount(d) == 2)
        d.members = [FlockMember(id: "m", name: "Me", role: .member, you: true)]
        #expect(PondHomeThreads.needsYouCount(d) == 1)
    }

    @Test func theFlockIsYouThenOnlineThenTheRest() {
        let members = [FlockMember(id: "a", name: "Zed"), FlockMember(id: "b", name: "Bea", online: true), FlockMember(id: "c", name: "Me", you: true), FlockMember(id: "d", name: "Amy")]
        let ordered = PondFlock.ordered(members, presence: [PondPresenceEntry(member: "a")])
        #expect(ordered.map(\.name) == ["Me", "Bea", "Zed", "Amy"])
    }

    @Test func presenceLinesSayTypingViewingOnlineOrAway() {
        let m = FlockMember(id: "a", name: "Aarav", role: .owner, nest: "Aarav's Mac")
        let threads = [PondThread(id: "t1", title: "Fix irrigation")]
        #expect(PondFlock.line(for: m, presence: [PondPresenceEntry(member: "a", typingIn: "t1")], threads: threads) == "Typing \u{00B7} Owner \u{00B7} Aarav's Mac")
        #expect(PondFlock.line(for: m, presence: [PondPresenceEntry(member: "a", viewing: "t1")], threads: threads).hasPrefix("Viewing Fix irrigation"))
        #expect(PondFlock.line(for: FlockMember(id: "z", name: "Z", nest: "Z Mac"), presence: [], threads: []) == "Away \u{00B7} Z Mac")
        // No Nest: a web guest, said plainly rather than left blank.
        #expect(PondFlock.line(for: FlockMember(id: "w", name: "W"), presence: [], threads: []) == "Away \u{00B7} Web")
        #expect(PondFlock.line(for: FlockMember(id: "z", name: "Z", nest: "Z Mac", online: true), presence: [], threads: []) == "Online \u{00B7} Z Mac")
    }

    @Test func typingLineNamesOthersInThatThreadOnly() {
        let members = [FlockMember(id: "a", name: "Aarav"), FlockMember(id: "b", name: "Bea"), FlockMember(id: "me", name: "Me", you: true)]
        let p = [PondPresenceEntry(member: "a", viewing: "t", typingIn: "t"), PondPresenceEntry(member: "b", viewing: "other", typingIn: "other"), PondPresenceEntry(member: "me", viewing: "t", typingIn: "t")]
        #expect(PondFlock.typingLine(in: "t", members: members, presence: p, excluding: "me") == "Aarav is typing")
        #expect(PondFlock.typingLine(in: "none", members: members, presence: p, excluding: "me") == nil)
        #expect(PondFlock.viewers(of: "t", members: members, presence: p, excluding: "me").map(\.id) == ["a"])
    }

    @Test func pondRipplesComeNewestFirstAndSkipTimelessOnes() {
        let feed = PondRippleFeed.build([
            RippleEntry(id: "1", at: t0.addingTimeInterval(-60), actor: "Aarav", text: "started Fix"),
            RippleEntry(id: "2", at: t0, actor: "Mira", text: "Mira joined"),
            RippleEntry(id: "3", at: nil, text: "no time"),
        ])
        #expect(feed.map(\.sentence) == ["Mira joined", "started Fix"])
    }

    @Test func yourOwnNestReadsThisMac() {
        let me = FlockMember(id: "m", name: "Sibhi", role: .owner, nest: "Studio Mac", online: true, you: true)
        #expect(PondFlock.line(for: me, presence: [], threads: []) == "Online \u{00B7} Owner \u{00B7} This Mac")
    }

    @Test func aRippleNeverShowsTheMemberId() {
        let feed = PondRippleFeed.build([
            RippleEntry(id: "1", at: t0, actor: "lIByWtA9Ar_SsAlK", actorName: "Sibhi", text: "Sibhi made the pond"),
            RippleEntry(id: "2", at: t0.addingTimeInterval(-5), actor: "lIByWtA9Ar_SsAlK", actorName: "Sibhi", text: "started Fix"),
            RippleEntry(id: "3", at: t0.addingTimeInterval(-9), actor: "zzzzzzzzzz", text: "An invite was revoked"),
        ])
        #expect(feed.map(\.sentence) == ["Sibhi made the pond", "Sibhi started Fix", "An invite was revoked"])
        #expect(!feed.contains { $0.sentence.contains("lIByWtA9Ar_SsAlK") || $0.sentence.contains("zzzzzzzzzz") })
    }

    @Test func roleDecidesWhoMayDoWhat() {
        #expect(PondRole.owner.canInvite && PondRole.owner.canApproveJoins && PondRole.owner.canRemoveMembers)
        #expect(!PondRole.member.canInvite && PondRole.member.canMessage)
        #expect(!PondRole.viewer.canMessage)
        #expect(PondRole(raw: "nonsense") == .viewer && PondRole(raw: nil) == .viewer)
    }
}

@Suite("Pond holds and invites")
struct PondHoldTests {
    private let holds = [PondHold(requestId: "q1", by: "m1", byName: "Aarav", until: t0.addingTimeInterval(20))]

    @Test func othersSeeWhoIsAnswering() {
        #expect(PondHolds.line("q1", holds: holds, me: "m2", now: t0) == "Aarav is answering")
        #expect(PondHolds.line("q2", holds: holds, me: "m2", now: t0) == nil)
    }

    @Test func yourOwnHoldAndAnExpiredOneSayNothing() {
        #expect(PondHolds.line("q1", holds: holds, me: "m1", now: t0) == nil)
        #expect(PondHolds.line("q1", holds: holds, me: "m2", now: t0.addingTimeInterval(21)) == nil)
    }

    @Test func aNamelessHoldStillSaysSomeone() {
        let h = [PondHold(requestId: "q", by: "x", byName: "", until: nil)]
        #expect(PondHolds.line("q", holds: h, me: "m", now: t0) == "Someone is answering")
    }

    @Test func aRefusalReadsAsWhoHoldsIt() {
        #expect(PondHolds.refused(by: "Aarav") == "Aarav is answering")
        #expect(PondHolds.refused(by: "Aarav is answering") == "Aarav is answering")
        #expect(PondHolds.refused(by: nil) == "Someone else is answering")
    }

    @Test func inviteExpiryAndJoinInput() {
        #expect(PondInviteText.expiry(t0.addingTimeInterval(59 * 60), now: t0) == "Expires in 59 min")
        #expect(PondInviteText.expiry(t0.addingTimeInterval(-1), now: t0) == "Expired")
        #expect(PondInviteText.expiry(nil, now: t0) == nil)
        #expect(PondInviteText.cleaned("  abc.def\n") == "abc.def")
        #expect(PondInviteText.cleaned("two words") == nil)
        #expect(PondInviteText.canJoin(code: "abc", name: "Mira") && !PondInviteText.canJoin(code: "abc", name: "  "))
    }
}

@Suite("Thread events")
struct ThreadEventTests {
    private func events(_ json: String) throws -> [ThreadEvent] { try JSONDecoder().decode(ThreadEventPage.self, from: Data(json.utf8)).events }

    @Test func everyEventTypeDecodes() throws {
        let e = try events(#"""
        {"events":[{"seq":1,"type":"user","by":"m1","text":"hi"},{"seq":2,"type":"thinking","text":"hm"},{"seq":3,"type":"tool","label":"Read a.ts","state":"done"},
        {"seq":4,"type":"question","requestId":"q","text":"Which?","options":["A","B"]},{"seq":5,"type":"approval","requestId":"a","label":"Run rm"},
        {"seq":6,"type":"resolved","requestId":"q"},{"seq":7,"type":"state","state":"working"},{"seq":8,"type":"changed","files":2,"added":5,"removed":1,"paths":["a","b"]},{"seq":9,"type":"???"}]}
        """#)
        #expect(e.count == 9)
        #expect(e[3].kind == .question(requestId: "q", text: "Which?", options: ["A", "B"]))
        #expect(e[7].kind == .changed(files: 2, added: 5, removed: 1, paths: ["a", "b"]))
        #expect(e[8].kind == .other("???"))
    }

    @Test func stepsBetweenMessagesFormOneRowAndQuestionsResolve() throws {
        let e = try events(#"""
        {"events":[{"seq":1,"type":"user","by":"m1","text":"fix"},{"seq":2,"type":"thinking","text":"hm"},{"seq":3,"type":"tool","label":"Read a.ts"},
        {"seq":4,"type":"agent","text":"Which way?"},{"seq":5,"type":"question","requestId":"q","text":"Which?","options":["A"]},
        {"seq":6,"type":"approval","requestId":"a","label":"Run x"},{"seq":7,"type":"resolved","requestId":"q"},{"seq":8,"type":"state","state":"needs_user_permission"}]}
        """#)
        let rows = ThreadTimeline.rows(e)
        #expect(rows.map(\.id) == [1, 2, 4, 5, 6])
        guard case .steps(_, let steps) = rows[1] else { Issue.record("no steps"); return }
        #expect(steps.map(\.kind) == ["thinking", "tool"] && steps[1].text == "Read a.ts")
        #expect(rows[3] == .question(id: 5, requestId: "q", text: "Which?", options: ["A"], resolved: true))
        #expect(ThreadTimeline.pending(e) == .approval(id: 6, requestId: "a", label: "Run x", resolved: false))
        #expect(ThreadTimeline.latestState(e) == .needsYou)
    }

    @Test func mergingAReplayAddsNothingTwiceAndResumesFromTheNewestSeq() {
        let a = ThreadEvent(seq: 1, kind: .agent(text: "a")), b = ThreadEvent(seq: 2, kind: .agent(text: "b")), c = ThreadEvent(seq: 3, kind: .agent(text: "c"))
        let merged = ThreadTimeline.merge([a, b], [b, c])
        #expect(merged.map(\.seq) == [1, 2, 3])
        #expect(ThreadTimeline.resumeSeq(merged) == 3 && ThreadTimeline.resumeSeq([]) == 0)
    }

    @Test func approvalsAreReadOnlyAndNameTheStarter() {
        #expect(PondThreadRules.approvalLine(starterName: "Aarav", isStarter: false) == "Waiting for Aarav to approve")
        #expect(PondThreadRules.approvalLine(starterName: "", isStarter: false) == "Waiting for the starter to approve")
        #expect(PondThreadRules.canTogglePrivate(starter: "m1", me: "m1") && !PondThreadRules.canTogglePrivate(starter: "m1", me: "m2") && !PondThreadRules.canTogglePrivate(starter: "m1", me: nil))
        #expect(PondThreadRules.composerPlaceholder(role: .viewer, working: true) == "Viewers can watch, not message")
    }
}
