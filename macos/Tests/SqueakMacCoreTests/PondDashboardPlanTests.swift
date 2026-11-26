import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct PondDashboardPlanTests {
    private func row(_ id: String, _ state: PondThreadState = .finished, at: TimeInterval? = nil, onDuty: Bool = true, needs: Bool = false) -> PondChatRow {
        var r = PondChatRow(id: id, title: id, agent: nil, state: state, mark: nil, lastAt: at.map { Date(timeIntervalSince1970: $0) },
                            local: nil, pondThread: nil, people: [])
        r.onDuty = onDuty
        if needs { r.hostNeedsYou = true }
        return r
    }

    // MARK: Header by role

    @Test func ownerOfAFolderPondSeesAllThreeButtonsAndNothingIsShared() {
        let h = PondDashboardHeader.make(.init(role: .owner, isLocal: true, plainFolder: true))
        #expect(h.stateLine == "Only on this Mac")
        #expect(h.start == .open(label: "Start a duck", help: "Start a duck in this Pond"))
        #expect(h.showsInvite)
        #expect(h.showsPutOnGitHub)
        #expect(h.closedLine == nil)
        #expect(h.menu == [.settings, .notebook, .rename, .delete])
    }

    @Test func putOnGitHubIsGoneOnceItIsAGitPond() {
        let h = PondDashboardHeader.make(.init(role: .owner, isLocal: false, plainFolder: false, people: 3))
        #expect(!h.showsPutOnGitHub)
        #expect(h.showsInvite)
        #expect(h.stateLine == "Shared with 3 people \u{00B7} Live")
    }

    @Test func sharedStateLineFollowsTheConnection() {
        func line(_ c: PondConnection) -> String { PondDashboardHeader.make(.init(role: .owner, people: 2, connection: c)).stateLine }
        #expect(line(.reconnecting) == "Shared with 2 people \u{00B7} Reconnecting\u{2026}")
        // The Owner's own Mac is never "offline" to the Owner.
        #expect(PondConnection.of(.offline(line: "x", asOf: nil), role: .owner) == .reconnecting)
        #expect(PondConnection.of(.offline(line: "x", asOf: nil), role: .member) == .ownerOffline)
        #expect(PondConnection.of(.refreshing, role: .viewer) == .live)
        #expect(PondConnection.of(.stale, role: .member) == .reconnecting)
    }

    @Test func memberGetsStartThatAsksTheOwnerAndNoInviteOrGitHub() {
        let h = PondDashboardHeader.make(.init(
            role: .member, isRemote: true, ownerName: "Sibhi", people: 4, start: .askOwner(label: "Ask Sibhi\u{2019}s Mac to start")))
        #expect(h.stateLine == "Sibhi\u{2019}s Pond \u{00B7} Member \u{00B7} Live")
        #expect(h.start == .open(label: "Start a duck", help: "Asks Sibhi to start it on their Mac"))
        #expect(!h.showsInvite)
        #expect(!h.showsPutOnGitHub)
        #expect(h.menu == [.settings, .notebook, .leave])
    }

    @Test func viewerHasTheStartButtonClosedWithItsReason() {
        let h = PondDashboardHeader.make(.init(role: .viewer, isRemote: true, ownerName: "Sibhi", connection: .ownerOffline, start: .hidden))
        #expect(h.stateLine == "Sibhi\u{2019}s Pond \u{00B7} Viewer \u{00B7} Sibhi\u{2019}s Mac offline")
        #expect(h.start == .closed(reason: "You can view this Pond. Ask Sibhi to make you a Member."))
        #expect(h.closedLine == "You can view this Pond. Ask Sibhi to make you a Member.")
        #expect(!h.showsInvite)
        #expect(h.menu.contains(.leave))
        #expect(!h.menu.contains(.delete))
    }

    @Test func aMemberWithoutTheStartCapSeesItClosedNotMissing() {
        let h = PondDashboardHeader.make(.init(role: .member, isRemote: true, ownerName: "Sibhi", start: .hidden))
        #expect(h.start == .closed(reason: "Ask Sibhi to let you start Ducks."))
    }

    @Test func aBlockedStartSaysWhyInsteadOfRefusingLater() {
        let h = PondDashboardHeader.make(.init(role: .owner, startBlockedReason: "This Mac can only share ducks into this Pond."))
        #expect(h.start == .closed(reason: "This Mac can only share ducks into this Pond."))
    }

    @Test func rolesNeverGetWhatTheyCannotUse() {
        for role in [PondRole.member, .viewer] {
            let h = PondDashboardHeader.make(.init(role: role, isRemote: true))
            #expect(!h.showsInvite && !h.showsPutOnGitHub)
            #expect(!h.menu.contains(.rename) && !h.menu.contains(.delete))
        }
        // A Pond the directory does not know yet cannot be invited to, renamed or deleted.
        let unknown = PondDashboardHeader.make(.init(role: .owner, hasPond: false, plainFolder: true))
        #expect(!unknown.showsInvite)
        #expect(unknown.menu == [.settings, .notebook])
        #expect(unknown.showsPutOnGitHub)
    }

    @Test func inviteWaitsWhileThePondIsUnreachable() {
        let h = PondDashboardHeader.make(.init(role: .owner, canWrite: false))
        #expect(h.showsInvite)
        #expect(h.inviteDisabledReason != nil)
    }

    // MARK: Avatars

    @Test func avatarsPutYouFirstAndPendingInvitesLastAsOutlined() {
        let row = PondAvatarRow.build(
            people: [(id: "a", name: "Asha", you: false), (id: "s", name: "Sibhi", you: true)], pendingInvites: 1)
        #expect(row.items == [.person(id: "s", name: "Sibhi", you: true), .person(id: "a", name: "Asha", you: false), .pending(index: 0)])
        #expect(row.more == 0)
    }

    @Test func avatarsCapWithAMoreCount() {
        let people = (0..<7).map { (id: "p\($0)", name: "P\($0)", you: $0 == 0) }
        let row = PondAvatarRow.build(people: people, pendingInvites: 2)
        #expect(row.items.count == PondAvatarRow.cap)
        #expect(row.more == 4)
    }

    // MARK: Ducks order

    @Test func workingFirstThenMostRecentAndOffDutyFolded() {
        let rows = [
            row("old-idle", at: 10), row("new-idle", at: 90), row("work-old", .working, at: 20), row("work-new", .working, at: 50),
            row("off-new", at: 95, onDuty: false), row("off-old", at: 5, onDuty: false),
        ]
        let s = PondDuckSections.build(rows)
        #expect(s.onDuty.map(\.id) == ["work-new", "work-old", "new-idle", "old-idle"])
        #expect(s.offDuty.map(\.id) == ["off-new", "off-old"])
    }

    @Test func aWaitingDuckStaysInTheListByRecencyNotByState() {
        let rows = [row("idle", at: 100), row("waiting", .needsYou, at: 50, needs: true)]
        #expect(PondDuckSections.build(rows).onDuty.map(\.id) == ["idle", "waiting"])
    }

    @Test func aDuckWithDucklingsRunningCountsAsWorkingOnlyWhenTheHostSaysNothing() {
        var a = row("a", at: 1); a.ducklingsRunning = 2
        var b = row("b", at: 2); b.ducklingsRunning = 2; b.statusLine = "Idle \u{00B7} 4m"
        #expect(PondDuckSections.build([b, a]).onDuty.map(\.id) == ["a", "b"])
    }

    @Test func equalTimesBreakTiesByTitle() {
        let s = PondDuckSections.build([row("b", at: 1), row("a", at: 1)])
        #expect(s.onDuty.map(\.id) == ["a", "b"])
    }

    // MARK: Blocks

    @Test func emptyPondShowsOnlyTheGuide() {
        let b = PondDashboardBlocks.of(needsYou: 0, ducks: PondDuckSections.build([]), latest: 0)
        #expect(b == PondDashboardBlocks(needsYou: false, ducks: false, offDuty: false, latest: false, emptyGuide: true))
    }

    @Test func blocksAppearOnlyWhenTheyHaveSomething() {
        let ducks = PondDuckSections.build([row("a"), row("z", onDuty: false)])
        let b = PondDashboardBlocks.of(needsYou: 2, ducks: ducks, latest: 3)
        #expect(b.needsYou && b.ducks && b.offDuty && b.latest && !b.emptyGuide)
        let quiet = PondDashboardBlocks.of(needsYou: 0, ducks: PondDuckSections.build([row("a")]), latest: 0)
        #expect(!quiet.needsYou && quiet.ducks && !quiet.offDuty && !quiet.latest)
    }

    @Test func onlyOffDutyDucksStillCountAsNotEmpty() {
        let b = PondDashboardBlocks.of(needsYou: 0, ducks: PondDuckSections.build([row("z", onDuty: false)]), latest: 0)
        #expect(!b.emptyGuide && !b.ducks && b.offDuty)
    }

    @Test func emptySentenceIsOneSentencePerRole() {
        for role in [PondRole.owner, .member, .viewer] {
            #expect(!PondDashboardBlocks.emptySentence(role: role).isEmpty)
        }
    }

    // MARK: Needs you

    @Test func ownerSeesDucksTaskApprovalsAndJoinsMemberSeesOwnWaitingTaskAsWords() {
        let rows = [row("pip", .needsYou, needs: true), row("calm")]
        let ask = RoomTask(id: "t1", messageId: "m", title: "Fix auth", state: .waiting, approvalName: "Asha")
        let blocked = RoomTask(id: "t2", messageId: "m", title: "Ship it", state: .blocked)
        let owner = PondDashboardNeedsYou.build(rows: rows, tasks: [ask, blocked], joins: [], role: .owner, ownerName: "Sibhi")
        #expect(owner.map(\.kind) == [.duck(rowId: "pip"), .taskApproval(taskId: "t1"), .taskBlocked(taskId: "t2")])
        #expect(owner.allSatisfy { $0.needsDecision })

        let member = PondDashboardNeedsYou.build(rows: rows, tasks: [ask, blocked], joins: [], role: .member, ownerName: "Sibhi")
        #expect(member.map(\.kind) == [.duck(rowId: "pip"), .taskWaiting(taskId: "t1")])
        #expect(member.last?.line == "Waiting for Sibhi")
        #expect(member.last?.needsDecision == false)
    }

    @Test func joinsOnlyReachTheOwner() throws {
        let join = try JSONDecoder().decode(JoinRequest.self, from: Data(#"{"requestId":"j1","name":"Dev","role":"member"}"#.utf8))
        #expect(PondDashboardNeedsYou.build(rows: [], tasks: [], joins: [join], role: .owner, ownerName: nil).map(\.kind) == [.join(requestId: "j1")])
        #expect(PondDashboardNeedsYou.build(rows: [], tasks: [], joins: [join], role: .member, ownerName: nil).isEmpty)
    }

    @Test func aFailedDuckSaysWhy() {
        var r = row("x", .failed, needs: true)
        r.failed = true; r.failureText = "out of credit"
        #expect(PondDashboardNeedsYou.build(rows: [r], tasks: [], joins: [], role: .owner, ownerName: nil).first?.line == "Failed: out of credit")
    }

    // MARK: Latest in the Room

    @Test func latestKeepsTheLastThreeRoomLinesOldestFirst() {
        func post(_ seq: Int, _ text: String, kind: RoomPostKind = .message, level: RoomLevel = .room) -> RoomPost {
            RoomPost(seq: seq, id: "p\(seq)", author: RoomAuthor(kind: .person, name: "Asha"), kind: kind, level: level, text: text, at: Int64(seq) * 1000)
        }
        let posts = [post(1, "one"), post(2, "two\nsecond line"), post(3, "agent chatter", level: .agents), post(4, "  "), post(5, "working", kind: .working),
                     post(6, "three"), post(7, "four")]
        let lines = PondLatest.build(posts)
        #expect(lines.map(\.text) == ["two", "three", "four"])
        #expect(PondLatest.build([]).isEmpty)
    }
}
