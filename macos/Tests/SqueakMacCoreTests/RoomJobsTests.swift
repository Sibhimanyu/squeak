import Foundation
import Testing

@testable import SqueakMacCore

@Suite("Room jobs")
struct RoomJobsTests {
    private let greeting = RoomJobTarget(sessionId: "s1", title: "Greeting Exchange", reason: "worked on the layout builder 10 min ago", state: "idle")
    private func job(_ id: String = "job:1", msg: String = "p1", status: RoomJobStatus = .suggested, suggestion: RoomJobTarget? = nil, claim: RoomJobClaim? = nil,
                     handed: RoomJobHandedTo? = nil, outcome: String? = nil, created: Int64 = 1, updated: Int64 = 1, candidates: [RoomJobTarget] = []) -> RoomJob {
        RoomJob(id: id, messageId: msg, text: "Fix the resize handles", status: status, suggestion: suggestion, candidates: candidates, claim: claim,
                handedTo: handed, outcomeText: outcome, createdAt: created, updatedAt: updated)
    }
    private func personPost(_ seq: Int, at: Int64 = 1_780_000_000_000) -> RoomPost {
        RoomPost(seq: seq, id: "p\(seq)", author: RoomAuthor(kind: .person, id: "me", name: "Sibhi Full Name"), kind: .message, level: .room, text: "Fix the resize handles", at: at)
    }

    @Test func pageDecodesJobsLeniently() throws {
        let json = """
        {"posts":[],"threads":[],"latestSeq":0,"jobs":[
          {"id":"job:1","messageId":"p1","text":"t","status":"suggested","createdAt":5,"updatedAt":6.0,"suggestion":{"sessionId":"s1","title":"A","reason":"r","state":"working"},"future":1},
          {"id":"job:2","messageId":"p2","status":"teleported"},
          {"messageId":"p3","status":"done"}]}
        """
        let page = try JSONDecoder().decode(RoomPage.self, from: Data(json.utf8))
        #expect(page.jobs?.map(\.id) == ["job:1"])
        #expect(page.jobs?.first?.updatedAt == 6)
        let none = try JSONDecoder().decode(RoomPage.self, from: Data(#"{"posts":[],"threads":[]}"#.utf8))
        #expect(none.jobs == nil)
    }

    @Test func upsertReplacesInPlaceAndIgnoresOlder() {
        var f = RoomFeed()
        f.upsert(job: job("job:a", created: 1)); f.upsert(job: job("job:b", created: 2)); f.upsert(job: job("job:c", created: 1))
        #expect(f.jobs.map(\.id) == ["job:a", "job:c", "job:b"])
        f.upsert(job: job("job:a", status: .running, created: 1, updated: 9))
        f.upsert(job: job("job:a", status: .suggested, created: 1, updated: 3))
        #expect(f.jobs.count == 3)
        #expect(f.jobs.first?.status == .running)
    }

    @Test func lineStates() {
        let sugg = RoomJobs.line(for: job(suggestion: greeting, candidates: [greeting, RoomJobTarget(sessionId: "s2", title: "Zoom")]))
        #expect(sugg.kind == .suggestion)
        #expect(sugg.lead == "Looks like a job \u{2192}")
        #expect(sugg.buttons.map(\.title) == ["Go", "New thread", "Just a note"])
        #expect(sugg.buttons.first?.role == .primary)
        #expect(sugg.buttons.first?.action == .go(sessionId: "s1"))
        #expect(sugg.candidates.map(\.sessionId) == ["s2"])

        let fresh = RoomJobs.line(for: job())
        #expect(fresh.kind == .newThread && fresh.targetTitle == "new thread")
        #expect(fresh.buttons.map(\.title) == ["Start", "Just a note"])

        let handed = RoomJobs.line(for: job(status: .handed, handed: RoomJobHandedTo(sessionId: "s1", title: "Greeting Exchange")))
        #expect(handed.kind == .handed && handed.lead == "Handed to" && handed.targetTitle == "Greeting Exchange" && handed.buttons.isEmpty)

        let running = RoomJobs.line(for: job(status: .running, handed: RoomJobHandedTo(sessionId: "s1", title: "Greeting Exchange")))
        #expect(running.kind == .running && running.mark == .working)

        let done = RoomJobs.line(for: job(status: .done, handed: RoomJobHandedTo(sessionId: "s1", title: "G", turnId: "t9"), outcome: "Handles fixed."))
        #expect(done.kind == .done && done.detail == "Handles fixed." && done.turnRowId == "s1:t9")
        let done2 = RoomJobs.line(for: job(status: .done, handed: RoomJobHandedTo(sessionId: "s1", title: "G", turnId: "s1:t9")))
        #expect(done2.turnRowId == "s1:t9")

        let failed = RoomJobs.line(for: job(status: .failed))
        #expect(failed.kind == .failed && failed.mark == .failed && failed.lead == "Didn\u{2019}t finish")

        #expect(RoomJobs.line(for: job(status: .dismissed)).isCollapsed)
    }

    @Test func optimisticActionsReconcileByJobId() {
        var f = RoomFeed()
        f.upsert(job: job(suggestion: greeting, updated: 1))
        f.beginJob("job:1", action: .go(sessionId: "s1"), title: "Greeting Exchange")
        var line = f.jobLine(forMessage: "p1")
        #expect(line?.kind == .handing && line?.targetTitle == "Greeting Exchange" && line?.buttons.isEmpty == true)
        f.upsert(job: job(status: .handed, suggestion: greeting, handed: RoomJobHandedTo(sessionId: "s1", title: "Greeting Exchange"), updated: 2))
        line = f.jobLine(forMessage: "p1")
        #expect(line?.kind == .handed)

        f.upsert(job: job("job:2", msg: "p2", suggestion: greeting, created: 5, updated: 5))
        f.beginJob("job:2", action: .dismiss)
        #expect(f.jobLine(forMessage: "p2")?.isCollapsed == true)
        f.failJob("job:2", message: "That job was already handed over.")
        let back = f.jobLine(forMessage: "p2")
        #expect(back?.kind == .suggestion && back?.error == "That job was already handed over.")
    }

    @Test func claimCardOnlyWhileAsking() {
        let asking = RoomJobClaim(sessionId: "s1", title: "Greeting Exchange", eta: "5 min", at: 10, status: .asking)
        var f = RoomFeed()
        f.upsert(job: job(suggestion: nil, claim: asking, updated: 1))
        #expect(f.claims.count == 1)
        #expect(f.claims[0].when == "after this turn, ~5 min")
        f.beginJob("job:1", action: .allow)
        #expect(f.claims.isEmpty)
        f.failJob("job:1", message: "no")
        #expect(f.claims.count == 1)
        f.upsert(job: job(claim: RoomJobClaim(sessionId: "s1", title: "G", status: .denied), updated: 2))
        #expect(f.claims.isEmpty)
        f.upsert(job: job("job:2", status: .handed, claim: asking, created: 2))
        #expect(f.claims.isEmpty)
        #expect(RoomJobs.when(eta: nil) == "after this turn")
    }

    @Test func claimsOrderIsStable() {
        let a = RoomJobClaim(sessionId: "s1", title: "A", at: 20)
        let b = RoomJobClaim(sessionId: "s2", title: "B", at: 10)
        let cards = RoomJobs.claims(jobs: [job("job:a", claim: a), job("job:b", claim: b)])
        #expect(cards.map(\.jobId) == ["job:b", "job:a"])
    }

    @Test func lineSitsUnderItsMessageAndCollapsesInPlace() {
        var f = RoomFeed()
        f.apply(page: RoomPage(posts: [personPost(1), personPost(2, at: 1_780_000_060_000)], latestSeq: 2, threads: [], turns: [], jobs: [job(suggestion: greeting)]))
        var r = RoomRipples.build(feed: f, filter: .all)
        let ids = r.map(\.id)
        let i = ids.firstIndex(of: "p1")!
        #expect(ids[i + 1] == "job:job:1")
        #expect(ids[i + 2] == "p2")
        f.upsert(job: job(status: .dismissed, suggestion: greeting, updated: 4))
        r = RoomRipples.build(feed: f, filter: .all)
        #expect(r.map(\.id) == ids)  // same rows, same places: the dismissed line only collapses
        #expect(RoomRipples.build(feed: f, filter: .agents).allSatisfy { if case .jobLine = $0 { false } else { true } })
    }

    @Test func makeThisAJobOffer() {
        let row = RoomRow(id: "p1", post: personPost(1), pending: false, failed: false)
        #expect(RoomJobs.canMakeJob(row, jobs: []))
        #expect(!RoomJobs.canMakeJob(row, jobs: [job(suggestion: greeting)]))
        #expect(RoomJobs.canMakeJob(row, jobs: [job(status: .dismissed)]))
        var pending = row; pending.pending = true
        #expect(!RoomJobs.canMakeJob(pending, jobs: []))
        var failed = RoomFeed()
        failed.failJob("msg:p1", message: "Not now.")
        #expect(failed.jobLine(forMessage: "p1")?.kind == .makeFailed)
    }

    @Test func actionBodiesAreStrict() {
        #expect(RoomJobAction.go(sessionId: "s1").body == .object(["action": .string("go"), "sessionId": .string("s1")]))
        #expect(RoomJobAction.go(sessionId: nil).body == .object(["action": .string("go")]))
        #expect(RoomJobAction.newThread.body == .object(["action": .string("new")]))
        #expect(RoomJobs.refusal(NativeHostError.http(409, "Already handed over.")) == "Already handed over.")
    }

    @Test func ownPromptsSayYou() {
        let me = RoomTurnAuthor(name: "Sibhi Full Name", me: true)
        let byName = RoomTurnAuthor(name: "sibhi full name", me: false)
        let other = RoomTurnAuthor(name: "Priya Nair", me: false)
        func t(_ a: RoomTurnAuthor) -> RoomTurn { RoomTurn(id: "x:1", sessionId: "x", threadTitle: "T", startedAt: 1, prompt: "hi", author: a) }
        #expect(RoomRipples.promptLine(t(me)) == .said(name: "You", quote: "hi"))
        #expect(RoomRipples.promptLine(t(byName), owner: "Sibhi Full Name") == .said(name: "You", quote: "hi"))
        #expect(RoomRipples.promptLine(t(other), owner: "Sibhi Full Name") == .said(name: "Priya Nair", quote: "hi"))
    }

    @Test func everyGroupCarriesItsThread() {
        var f = RoomFeed()
        let turns = (0..<3).map { RoomTurn(id: "s1:\($0)", sessionId: "s1", threadTitle: "Greeting Exchange", startedAt: 1_780_000_000_000 + Int64($0) * 60_000, endedAt: 1_780_000_000_000 + Int64($0) * 60_000 + 1000, outcome: .finished) }
        f.apply(page: RoomPage(posts: [], latestSeq: 0, threads: [], turns: turns))
        let groups = RoomRipples.build(feed: f, filter: .all).compactMap { if case .threadTurns(let g) = $0 { g } else { nil } }
        #expect(groups.count == 1 && groups[0].title == "Greeting Exchange" && groups[0].rows.count == 3)
    }
}
