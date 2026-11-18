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
        #expect(sugg.buttons.map(\.title) == ["Go", "New duck", "Just a note"])
        #expect(sugg.buttons.first?.role == .primary)
        #expect(sugg.buttons.first?.action == .go(sessionId: "s1"))
        #expect(sugg.candidates.map(\.sessionId) == ["s2"])

        let fresh = RoomJobs.line(for: job())
        #expect(fresh.kind == .newThread && fresh.targetTitle == "new duck")
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

    // MARK: Place

    private func placed(_ place: RoomJobPlace?, text: String = "Fix the resize handles") -> RoomJob {
        RoomJob(id: "job:1", messageId: "p1", text: text, suggestion: greeting, place: place)
    }
    private func ws(_ id: String, _ branch: String, _ age: TimeInterval?, state: String = "ready", project: String = "p") -> NativeWorkspace {
        var w = NativeWorkspace(id: id, projectId: project, name: id, path: "/" + id, branch: branch, state: state)
        w.createdAt = age.map { Date(timeIntervalSince1970: 1_780_000_000 - $0) }
        return w
    }

    @Test func theChipSaysWhereTheWorkGoes() {
        let stream = RoomJobPlace.stream(workspaceId: "w1", branch: "feat/handles")
        #expect(RoomPlaces.chip(for: placed(stream), chosen: nil)?.text == "\u{2192} on feat/handles")
        #expect(RoomPlaces.chip(for: placed(.new(branch: "fix-handles")), chosen: nil)?.text == "\u{2192} new stream fix-handles")
        #expect(RoomPlaces.chip(for: placed(nil), chosen: nil) == nil)  // a folder pond: no chip
        let c = RoomPlaces.chip(for: placed(stream), chosen: .new(branch: "x"))
        #expect(c?.text == "\u{2192} new stream x" && c?.changed == true)
        #expect(RoomPlaces.chip(for: placed(stream), chosen: stream)?.changed == false)
    }

    @Test func theMenuListsStreamsNewestFirstThenANewStream() {
        let list = RoomPlaces.streams([ws("a", "old", 900), ws("b", "new", 10), ws("c", "undated", nil), ws("d", "gone", 5, state: "archived"), ws("e", "other", 1, project: "q")], projectId: "p")
        #expect(list.map(\.branch) == ["new", "old", "undated"])
        let job = placed(.new(branch: "fix-handles"))
        let items = RoomPlaces.menu(streams: list, current: .stream(workspaceId: "b", branch: "new"), prefill: RoomPlaces.suggestedBranch(job: job, chosen: nil))
        #expect(items.count == 4)
        #expect(items[0] == .stream(list[0], selected: true))
        #expect(items[3] == .newStream(prefill: "fix-handles", selected: false))
        #expect(RoomPlaces.suggestedBranch(job: placed(nil), chosen: nil) == "fix-the-resize-handles")
    }

    @Test func aNewStreamsNameIsCheckedLikeGit() {
        let taken = ["main", "feat/x"]
        #expect(RoomPlaces.branchProblem("fix-handles", taken: taken) == nil)
        #expect(RoomPlaces.branchProblem("feat/new-thing", taken: taken) == nil)
        for bad in ["", "  ", "a b", "a..b", "/a", "a/", "a.", "a//b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "@", "a@{b", ".hidden", "x/.y", "topic.lock", "a\u{7f}b"] {
            #expect(RoomPlaces.branchProblem(bad, taken: taken) != nil, "\(bad)")
        }
        #expect(RoomPlaces.branchProblem("feat/x", taken: taken) == "A stream is already on feat/x.")
    }

    @Test func goAllowAndNewCarryThePlaceAndNothingElseDoes() {
        let p = RoomJobPlace.stream(workspaceId: "w1", branch: "b")
        #expect(RoomJobAction.go(sessionId: "s1").body(place: p) == .object(["action": .string("go"), "sessionId": .string("s1"), "place": .object(["kind": .string("stream"), "workspaceId": .string("w1"), "branch": .string("b")])]))
        #expect(RoomJobAction.newThread.body(place: .new(branch: "n")) == .object(["action": .string("new"), "place": .object(["kind": .string("new"), "branch": .string("n")])]))
        #expect(RoomJobAction.allow.body(place: p) != RoomJobAction.allow.body)
        #expect(RoomJobAction.dismiss.body(place: p) == RoomJobAction.dismiss.body)
        #expect(RoomJobAction.deny.body(place: p) == RoomJobAction.deny.body)
        #expect(RoomJobAction.go(sessionId: "s1").body == .object(["action": .string("go"), "sessionId": .string("s1")]))
    }

    @Test func thePickedPlaceRidesOnGoAndShowsOnTheOffer() throws {
        let json = #"{"id":"job:1","messageId":"p1","text":"t","status":"suggested","place":{"kind":"new","branch":"fix-handles"},"suggestion":{"sessionId":"s1","title":"A","reason":"r","state":"idle","pitch":"did x"}}"#
        let j = try JSONDecoder().decode(RoomJob.self, from: Data(json.utf8))
        #expect(j.place == .new(branch: "fix-handles"))
        var f = RoomFeed()
        f.upsert(job: j)
        #expect(f.placeToSend(jobId: "job:1", action: .go(sessionId: "s1")) == .new(branch: "fix-handles"))
        f.setJobPlace("job:1", .stream(workspaceId: "w2", branch: "main-ish"))
        #expect(f.placeToSend(jobId: "job:1", action: .go(sessionId: "s1")) == .stream(workspaceId: "w2", branch: "main-ish"))
        #expect(f.placeToSend(jobId: "job:1", action: .dismiss) == nil)
        let offer = RoomMessages.offerMessage(j, target: j.suggestion!, local: nil, threads: [:], at: 1, place: RoomPlaces.chip(for: j, chosen: f.jobPlace["job:1"]))
        guard case .offer(let o) = offer.parts[0] else { Issue.record("no offer"); return }
        #expect(o.place?.text == "\u{2192} on main-ish" && o.place?.changed == true)
    }
}
