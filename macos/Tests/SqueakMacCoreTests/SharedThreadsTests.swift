import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Threads other people started: the sidebar, the changes, starting on the owner's Mac")
struct SharedThreadsTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func ago(_ s: TimeInterval) -> Date { now.addingTimeInterval(-s) }

    private func detail(role: PondRole = .member, threads: [PondThread], me: String = "me") -> PondDetail {
        let pond = PondSummary(id: "p1", name: "Site", role: role, ownerName: "Sibhi")
        return PondDetail(pond: pond, members: [FlockMember(id: "a", name: "Aarav Patel"), FlockMember(id: "me", name: "Me", you: true)], threads: threads, me: PondMe(id: me, role: role))
    }
    private func thread(_ id: String, _ title: String, by: String = "a", state: String = "idle", at: TimeInterval = 60, isPrivate: Bool = false, waitingOn: String? = nil) -> PondThread {
        var t = PondThread(id: id, title: title, starter: by, starterName: by == "a" ? "Aarav Patel" : "Me", state: state, isPrivate: isPrivate, updatedAt: ago(at))
        t.waitingOn = waitingOn
        return t
    }

    // MARK: Sidebar

    @Test func listsOnlyThreadsSomeoneElseStartedNewestFirstTiesByTitle() {
        let d = detail(threads: [
            thread("t1", "Old", at: 3600), thread("t2", "Mine", by: "me", at: 10), thread("t3", "Newest", at: 30),
            thread("t4", "b same", at: 600), thread("t5", "A same", at: 600),
        ])
        #expect(SharedThreadRows.rows(d, now: now).map(\.title) == ["Newest", "A same", "b same", "Old"])
    }

    @Test func aPrivateThreadNeverGetsARow() {
        let d = detail(threads: [thread("t1", "Secret", at: 5, isPrivate: true), thread("t2", "Open", at: 10)])
        #expect(SharedThreadRows.rows(d, now: now).map(\.threadId) == ["t2"])
    }

    @Test func aMemberStartedThreadInMyOwnPondShows() {
        let d = detail(role: .owner, threads: [thread("t1", "From Aarav", by: "a"), thread("t2", "Mine", by: "me")])
        #expect(SharedThreadRows.rows(d, now: now).map(\.threadId) == ["t1"])
    }

    @Test func stateIsWorkingNeedsYouOrFinishedAndAnIdleOneAgesOutAfterADay() {
        let d = detail(threads: [
            thread("w", "Working", state: "working", at: 2 * 86_400), thread("q", "Asks", state: "waiting", at: 3 * 86_400, waitingOn: "question"),
            thread("f", "Done", state: "idle", at: 3600), thread("old", "Done long ago", state: "idle", at: 2 * 86_400),
        ])
        let rows = SharedThreadRows.rows(d, now: now)
        #expect(Set(rows.map(\.threadId)) == ["w", "q", "f"])
        #expect(rows.first { $0.threadId == "w" }?.mark == ChatMark(.working))
        #expect(rows.first { $0.threadId == "q" }?.mark == ChatMark(.waiting, waiting: .answer))
        #expect(rows.first { $0.threadId == "f" }?.mark == nil)
        // The open one stays even when old.
        #expect(SharedThreadRows.rows(d, now: now, keeping: "old").map(\.threadId).contains("old"))
        #expect(SharedThreadRows.foldedState(rows) == .needsYou)
    }

    @Test func anApprovalWaitsOnTheStarterNotOnMe() {
        let d = detail(threads: [thread("t", "Edit", state: "waiting", waitingOn: "approval")])
        let r = SharedThreadRows.rows(d, now: now)[0]
        #expect(r.mark == nil)
        #expect(r.help.contains("Waiting for Aarav Patel to approve"))
    }

    @Test func aRowCarriesTheStartersAvatarAndOwnershipTooltip() {
        let r = SharedThreadRows.rows(detail(threads: [thread("t", "Fix login")]), now: now)[0]
        #expect(r.avatar == PondAvatars.spec(memberId: "a", name: "Aarav Patel"))
        #expect(r.avatar.initials == "AP")
        #expect(r.help == "Fix login\nAarav Patel\u{2019}s thread \u{00B7} runs on their Mac")
        #expect(r.id == "p1/t")
    }

    @Test func nothingListedWithoutKnowingWhoIAmOrForAPondThatIsNotActive() {
        var d = detail(threads: [thread("t", "x")])
        d.me = nil
        d.members = d.members.map { var m = $0; m.you = false; return m }
        #expect(SharedThreadRows.rows(d, now: now).isEmpty)
        var p = detail(threads: [thread("t", "x")])
        p.pond = PondSummary(id: "p1", name: "Site", role: .member, status: "pending")
        #expect(SharedThreadRows.rows(p, now: now).isEmpty)
    }

    // MARK: Changes

    @Test func theStartersAnswerDecodesAndDrawsAsTheNormalListing() throws {
        let json = #"{"files":[{"path":"src/a.ts","changes":4},{"path":"README.md"}],"summary":{"files":2,"added":5,"removed":1},"patch":{"path":"src/a.ts","text":"@@ -1 +1 @@\n-a\n+b","truncated":false},"expiresAt":1800000600000,"future":1}"#
        let c = try JSONDecoder().decode(PondChanges.self, from: Data(json.utf8))
        #expect(PondChangesView.header(c) == "2 files changed")
        #expect(PondChangesView.listing(c).map(\.path) == ["src/a.ts", "README.md"])
        #expect(PondChangesView.listing(c)[0].added == 4)
        #expect(c.patch?.text.hasSuffix("+b") == true)
        let reply = try JSONDecoder().decode(PondChangesReply.self, from: Data(#"{"ready":false,"requestId":"r1"}"#.utf8))
        #expect(!reply.ready && reply.requestId == "r1" && reply.result == nil)
    }

    @Test func theTurnEndEventStandsInForTheListAndSaysWhenToAskAgain() throws {
        func ev(_ seq: Int, _ kind: ThreadEvent.Kind) -> ThreadEvent { ThreadEvent(seq: seq, at: nil, kind: kind) }
        let events = [ev(1, .agent(text: "hi")), ev(2, .changed(files: 2, added: 3, removed: 1, paths: ["a", "b"])), ev(3, .state("idle"))]
        let stand = PondChangesView.fromEvents(events)
        #expect(stand?.files.map(\.path) == ["a", "b"] && stand?.summary == .init(files: 2, added: 3, removed: 1))
        #expect(PondChangesView.turnEndStamp(events) == 2)
        #expect(PondChangesView.turnEndStamp([ev(1, .agent(text: "x"))]) == 0)
        #expect(PondChangesView.shouldAsk(open: true, stamp: 2, askedAt: nil))
        #expect(!PondChangesView.shouldAsk(open: true, stamp: 2, askedAt: 2))
        #expect(!PondChangesView.shouldAsk(open: false, stamp: 5, askedAt: nil))
    }

    // MARK: Starting on the owner's Mac

    @Test func aThreadStartedForARequestIsFoundByItsIdAndNeverWhenPrivate() throws {
        let t = try JSONDecoder().decode(PondThread.self, from: Data(#"{"id":"t9","title":"Outline","starter":"o","starterName":"Sibhi","requester":{"memberId":"m","requestId":"req1"},"state":"working","private":false,"mode":"shared"}"#.utf8))
        #expect(t.requestId == "req1")
        #expect(PondStartRequest.thread(for: "req1", in: [t])?.id == "t9")
        #expect(PondStartRequest.thread(for: "other", in: [t]) == nil)
        var hidden = t; hidden.isPrivate = true
        #expect(PondStartRequest.thread(for: "req1", in: [hidden]) == nil)
        #expect(PondThread(id: "x", title: "").requestId == nil)
    }

    @Test func theLinesAreFixedSentences() {
        #expect(PondStartRequest.placeLine(ownerName: "Sibhi") == "Runs on Sibhi\u{2019}s Mac")
        #expect(PondStartRequest.placeLine(ownerName: nil) == "Runs on the owner\u{2019}s Mac")
        #expect(PondStartRequest.waitingLine(ownerName: "Sibhi") == "Waiting for Sibhi\u{2019}s Mac to start your thread.")
        #expect(PondStartRequest.isExpired(askedAt: ago(301), now: now) && !PondStartRequest.isExpired(askedAt: ago(60), now: now))
    }

    @Test func aSharedPondWithNoRemoteStartsOnTheOwnersMacAndAViewerCannot() {
        let shared = PondSummary(id: "p", name: "Notes", role: .member, projectId: nil, canStartHere: false, ownerName: "Sibhi")
        #expect(PondStartThread.runsOnOwnerMac(shared))
        guard case .open(_, let context) = PondThreadEntry.resolve(pond: shared, workspaces: []) else { Issue.record("expected the owner's Mac"); return }
        #expect(context.runsOnOwner && context.ownerMac == "Sibhi" && !context.canRunHere)
        let viewer = PondSummary(id: "p", name: "Notes", role: .viewer, ownerName: "Sibhi")
        #expect(!PondStartThread.runsOnOwnerMac(viewer))
        if case .refuse = PondThreadEntry.resolve(pond: viewer, workspaces: []) {} else { Issue.record("a viewer cannot start") }
    }

    @Test func aSharedPondThisMacCanStartInOffersBothPlaces() {
        let shared = PondSummary(id: "p", name: "Site", role: .member, gitRemote: "git@x:a/b.git", projectId: "proj", canStartHere: true, ownerName: "Sibhi")
        guard case .open(_, let context) = PondThreadEntry.resolve(pond: shared, workspaces: []) else { Issue.record("expected open"); return }
        #expect(context.ownerMac == "Sibhi" && !context.runsOnOwner && context.canRunHere)
        let mine = PondSummary(id: "p", name: "Site", role: .owner, gitRemote: "git@x:a/b.git", projectId: "proj", canStartHere: true)
        guard case .open(_, let own) = PondThreadEntry.resolve(pond: mine, workspaces: []) else { Issue.record("expected open"); return }
        #expect(own.ownerMac == nil)
    }
}
