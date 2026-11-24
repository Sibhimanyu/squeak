import Foundation
import Testing

@testable import SqueakMacCore

@Suite("Room jobs")
struct RoomTasksTests {
    private let greeting = RoomTaskTarget(sessionId: "s1", title: "Greeting Exchange", reason: "worked on the layout builder 10 min ago", state: "idle")
    private func job(_ id: String = "job:1", msg: String = "p1", state: RoomTaskState = .waiting, suggestion: RoomTaskTarget? = nil, claim: RoomTaskClaim? = nil,
                     handed: RoomTaskHandedTo? = nil, outcome: String? = nil, created: Int64 = 1, updated: Int64 = 1, candidates: [RoomTaskTarget] = [], proposed: Bool = false, discussion: [RoomTaskMessage] = [], parent: String? = nil) -> RoomTask {
        RoomTask(id: id, messageId: msg, text: "Fix the resize handles", state: state, proposed: proposed, parentTaskId: parent, discussion: discussion, suggestion: suggestion, candidates: candidates, claim: claim,
                handedTo: handed, result: outcome, createdAt: created, updatedAt: updated)
    }
    private func personPost(_ seq: Int, at: Int64 = 1_780_000_000_000) -> RoomPost {
        RoomPost(seq: seq, id: "p\(seq)", author: RoomAuthor(kind: .person, id: "me", name: "Sibhi Full Name"), kind: .message, level: .room, text: "Fix the resize handles", at: at)
    }

    @Test func pageDecodesJobsLeniently() throws {
        let json = """
        {"posts":[],"threads":[],"latestSeq":0,"tasks":[
          {"id":"job:1","messageId":"p1","text":"t","state":"waiting","createdAt":5,"updatedAt":6.0,"suggestion":{"sessionId":"s1","title":"A","reason":"r","state":"working"},"future":1},
          {"id":"job:2","messageId":"p2","state":"teleported"},
          {"messageId":"p3","state":"done"}]}
        """
        let page = try JSONDecoder().decode(RoomPage.self, from: Data(json.utf8))
        #expect(page.tasks?.map(\.id) == ["job:1"])
        #expect(page.tasks?.first?.updatedAt == 6)
        let none = try JSONDecoder().decode(RoomPage.self, from: Data(#"{"posts":[],"threads":[]}"#.utf8))
        #expect(none.tasks == nil)
    }

    @Test func upsertReplacesInPlaceAndIgnoresOlder() {
        var f = RoomFeed()
        f.upsert(job: job("job:a", created: 1)); f.upsert(job: job("job:b", created: 2)); f.upsert(job: job("job:c", created: 1))
        #expect(f.jobs.map(\.id) == ["job:a", "job:c", "job:b"])
        f.upsert(job: job("job:a", state: .working, created: 1, updated: 9))
        f.upsert(job: job("job:a", state: .waiting, created: 1, updated: 3))
        #expect(f.jobs.count == 3)
        #expect(f.jobs.first?.state == .working)
    }

    @Test func lineStates() {
        let sugg = RoomTasks.line(for: job(suggestion: greeting, candidates: [greeting, RoomTaskTarget(sessionId: "s2", title: "Zoom")], proposed: true))
        #expect(sugg.kind == .suggestion)
        #expect(RoomTasks.line(for: job(suggestion: greeting)).lead == "Task \u{2192}")
        #expect(sugg.lead == "Looks like a task \u{2192}")
        #expect(sugg.buttons.map(\.title) == ["Go", "New duck", "Drop"])
        #expect(sugg.buttons.first?.role == .primary)
        #expect(sugg.buttons.first?.action == .go(sessionId: "s1"))
        #expect(sugg.candidates.map(\.sessionId) == ["s2"])

        let fresh = RoomTasks.line(for: job())
        #expect(fresh.kind == .newThread && fresh.targetTitle == "new duck")
        #expect(fresh.buttons.map(\.title) == ["Start", "Drop"])

        let running = RoomTasks.line(for: job(state: .working, handed: RoomTaskHandedTo(sessionId: "s1", title: "Greeting Exchange")))
        #expect(running.kind == .running && running.mark == .working)

        let done = RoomTasks.line(for: job(state: .done, handed: RoomTaskHandedTo(sessionId: "s1", title: "G", turnId: "t9"), outcome: "Handles fixed."))
        #expect(done.kind == .done && done.detail == "Handles fixed." && done.turnRowId == "s1:t9")
        let done2 = RoomTasks.line(for: job(state: .done, handed: RoomTaskHandedTo(sessionId: "s1", title: "G", turnId: "s1:t9")))
        #expect(done2.turnRowId == "s1:t9")

        let failed = RoomTasks.line(for: job(state: .blocked))
        #expect(failed.kind == .blocked && failed.mark == .failed && failed.lead == "Didn\u{2019}t finish")

        #expect(RoomTasks.line(for: job(state: .dropped)).isCollapsed)
    }

    @Test func optimisticActionsReconcileByJobId() {
        var f = RoomFeed()
        f.upsert(job: job(suggestion: greeting, updated: 1))
        f.beginJob("job:1", action: .go(sessionId: "s1"), title: "Greeting Exchange")
        var line = f.jobLine(forMessage: "p1")
        #expect(line?.kind == .handing && line?.targetTitle == "Greeting Exchange" && line?.buttons.isEmpty == true)
        f.upsert(job: job(state: .working, suggestion: greeting, handed: RoomTaskHandedTo(sessionId: "s1", title: "Greeting Exchange"), updated: 2))
        line = f.jobLine(forMessage: "p1")
        #expect(line?.kind == .running)

        f.upsert(job: job("job:2", msg: "p2", suggestion: greeting, created: 5, updated: 5))
        f.beginJob("job:2", action: .drop)
        #expect(f.jobLine(forMessage: "p2")?.isCollapsed == true)
        f.failJob("job:2", message: "That job was already handed over.")
        let back = f.jobLine(forMessage: "p2")
        #expect(back?.kind == .suggestion && back?.error == "That job was already handed over.")
    }

    @Test func claimCardOnlyWhileAsking() {
        let asking = RoomTaskClaim(sessionId: "s1", title: "Greeting Exchange", eta: "5 min", at: 10, status: .asking)
        var f = RoomFeed()
        f.upsert(job: job(suggestion: nil, claim: asking, updated: 1))
        #expect(f.claims.count == 1)
        #expect(f.claims[0].when == "after this turn, ~5 min")
        f.beginJob("job:1", action: .allow)
        #expect(f.claims.isEmpty)
        f.failJob("job:1", message: "no")
        #expect(f.claims.count == 1)
        f.upsert(job: job(claim: RoomTaskClaim(sessionId: "s1", title: "G", status: .denied), updated: 2))
        #expect(f.claims.isEmpty)
        f.upsert(job: job("job:2", state: .working, claim: asking, created: 2))
        #expect(f.claims.isEmpty)
        #expect(RoomTasks.when(eta: nil) == "after this turn")
    }

    @Test func claimsOrderIsStable() {
        let a = RoomTaskClaim(sessionId: "s1", title: "A", at: 20)
        let b = RoomTaskClaim(sessionId: "s2", title: "B", at: 10)
        let cards = RoomTasks.claims(jobs: [job("job:a", claim: a), job("job:b", claim: b)])
        #expect(cards.map(\.jobId) == ["job:b", "job:a"])
    }

    @Test func makeThisAJobOffer() {
        let row = RoomRow(id: "p1", post: personPost(1), pending: false, failed: false)
        #expect(RoomTasks.canMakeTask(row, jobs: []))
        #expect(!RoomTasks.canMakeTask(row, jobs: [job(suggestion: greeting)]))
        #expect(RoomTasks.canMakeTask(row, jobs: [job(state: .dropped)]))
        var pending = row; pending.pending = true
        #expect(!RoomTasks.canMakeTask(pending, jobs: []))
        var failed = RoomFeed()
        failed.failJob("msg:p1", message: "Not now.")
        #expect(failed.jobLine(forMessage: "p1")?.kind == .makeFailed)
    }

    @Test func actionBodiesAreStrict() {
        #expect(RoomTaskAction.go(sessionId: "s1").body == .object(["action": .string("go"), "sessionId": .string("s1")]))
        #expect(RoomTaskAction.go(sessionId: nil).body == .object(["action": .string("go")]))
        #expect(RoomTaskAction.newThread.body == .object(["action": .string("new")]))
        #expect(RoomTasks.refusal(NativeHostError.http(409, "Already handed over.")) == "Already handed over.")
    }

    // MARK: Place

    private func placed(_ place: RoomTaskPlace?, text: String = "Fix the resize handles") -> RoomTask {
        RoomTask(id: "job:1", messageId: "p1", text: text, suggestion: greeting, place: place)
    }
    private func ws(_ id: String, _ branch: String, _ age: TimeInterval?, state: String = "ready", project: String = "p") -> NativeWorkspace {
        var w = NativeWorkspace(id: id, projectId: project, name: id, path: "/" + id, branch: branch, state: state)
        w.createdAt = age.map { Date(timeIntervalSince1970: 1_780_000_000 - $0) }
        return w
    }

    @Test func theChipSaysWhereTheWorkGoes() {
        let stream = RoomTaskPlace.stream(workspaceId: "w1", branch: "feat/handles")
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
        let p = RoomTaskPlace.stream(workspaceId: "w1", branch: "b")
        #expect(RoomTaskAction.go(sessionId: "s1").body(place: p) == .object(["action": .string("go"), "sessionId": .string("s1"), "place": .object(["kind": .string("stream"), "workspaceId": .string("w1"), "branch": .string("b")])]))
        #expect(RoomTaskAction.newThread.body(place: .new(branch: "n")) == .object(["action": .string("new"), "place": .object(["kind": .string("new"), "branch": .string("n")])]))
        #expect(RoomTaskAction.allow.body(place: p) != RoomTaskAction.allow.body)
        #expect(RoomTaskAction.drop.body(place: p) == RoomTaskAction.drop.body)
        #expect(RoomTaskAction.deny.body(place: p) == RoomTaskAction.deny.body)
        #expect(RoomTaskAction.go(sessionId: "s1").body == .object(["action": .string("go"), "sessionId": .string("s1")]))
    }

    @Test func thePickedPlaceRidesOnGoAndShowsOnTheOffer() throws {
        let json = #"{"id":"job:1","messageId":"p1","text":"t","state":"waiting","place":{"kind":"new","branch":"fix-handles"},"suggestion":{"sessionId":"s1","title":"A","reason":"r","state":"idle","pitch":"did x"}}"#
        let j = try JSONDecoder().decode(RoomTask.self, from: Data(json.utf8))
        #expect(j.place == .new(branch: "fix-handles"))
        var f = RoomFeed()
        f.upsert(job: j)
        #expect(f.placeToSend(jobId: "job:1", action: .go(sessionId: "s1")) == .new(branch: "fix-handles"))
        f.setJobPlace("job:1", .stream(workspaceId: "w2", branch: "main-ish"))
        #expect(f.placeToSend(jobId: "job:1", action: .go(sessionId: "s1")) == .stream(workspaceId: "w2", branch: "main-ish"))
        #expect(f.placeToSend(jobId: "job:1", action: .drop) == nil)
        let offer = RoomMessages.offerMessage(j, target: j.suggestion!, local: nil, threads: [:], at: 1, place: RoomPlaces.chip(for: j, chosen: f.jobPlace["job:1"]))
        guard case .offer(let o) = offer.parts[0] else { Issue.record("no offer"); return }
        #expect(o.place?.text == "\u{2192} on main-ish" && o.place?.changed == true)
    }

    // MARK: Tasks

    private func msg(_ id: String, _ author: String = "Sam", _ text: String = "hi") -> RoomTaskMessage { RoomTaskMessage(id: id, author: author, text: text, at: 1) }

    @Test func aTaskDecodesItsStateTitleParentDiscussionAndResult() throws {
        let json = """
        {"id":"task:1","messageId":"p1","text":"Fix the bar. Now.","title":"Fix the bar","state":"done","parentTaskId":"task:0","result":"Fixed.",
         "discussion":[{"id":"p0","author":"Sam","text":"the bar is off","at":3},{"nope":1}],"createdAt":1,"updatedAt":2}
        """
        let t = try JSONDecoder().decode(RoomTask.self, from: Data(json.utf8))
        #expect(t.state == .done && t.title == "Fix the bar" && t.parentTaskId == "task:0" && t.result == "Fixed.")
        #expect(t.discussion.map(\.id) == ["p0"])
        let bare = try JSONDecoder().decode(RoomTask.self, from: Data(#"{"id":"a","messageId":"m","text":"Add dark mode.\nSecond line","state":"waiting"}"#.utf8))
        #expect(bare.title == "Add dark mode" && bare.proposed == false && bare.discussion.isEmpty)
        #expect(RoomTasks.title(of: "") == "New task")
        #expect(RoomTasks.title(of: String(repeating: "a", count: 90)).count == 60)
    }

    @Test func everyTaskShowsItsStateAndADroppedOneLeaves() {
        let tasks = [
            job("t:w", state: .waiting), job("t:k", state: .working, handed: RoomTaskHandedTo(sessionId: "s1", title: "Pip")),
            job("t:b", state: .blocked), job("t:d", state: .done, outcome: "Fixed."), job("t:x", state: .dropped),
            job("t:s", state: .waiting, proposed: true),
        ]
        let cards = tasks.map { RoomTasks.card(for: $0, among: tasks) }
        #expect(cards.map { $0?.stateLabel } == ["Waiting", "Working", "Blocked", "Done", nil, "Suggested"])
        #expect(cards[1]?.opens == "s1" && cards[3]?.result == "Fixed." && cards[3]?.canDrop == false && cards[0]?.canDrop == true)
        var f = RoomFeed()
        for t in tasks { f.upsert(job: t) }
        let lines = RoomMessages.build(feed: f, now: Date(timeIntervalSince1970: 1_780_000_100), calendar: Calendar(identifier: .gregorian)).compactMap { item -> RoomSystemLine? in if case .system(let s) = item, s.task != nil { s } else { nil } }
        #expect(lines.compactMap { $0.task?.taskId }.sorted() == ["t:b", "t:d", "t:k", "t:s", "t:w"])
    }

    @Test func aTaskKnowsItsParentAndDropIsPendingAtOnce() {
        let parent = job("t:p"); var child = job("t:c", parent: "t:p"); child.title = "Dark mode"
        #expect(RoomTasks.card(for: child, among: [parent, child])?.parentTitle == parent.title)
        #expect(RoomTasks.card(for: child, among: [child], local: RoomTaskLocal(pending: .drop)) == nil)
    }

    @Test func trimmingLeavesMessagesOutAndOnlyWhatWasTrimmedIsSent() {
        let t = job("t:1", discussion: [msg("p0"), msg("p5"), msg("p1")])
        var f = RoomFeed()
        f.upsert(job: t)
        let card = RoomTasks.card(for: t, among: [t], excluded: [])!
        #expect(card.discussion.map(\.id) == ["p0", "p5"] && card.discussionSummary == "2 messages")
        #expect(f.includeToSend(taskId: "t:1", action: .go(sessionId: nil)) == nil)
        f.setIncluded("p5", false, task: "t:1")
        #expect(f.includeToSend(taskId: "t:1", action: .newThread) == ["p0", "p1"])
        #expect(f.includeToSend(taskId: "t:1", action: .drop) == nil)
        #expect(RoomTasks.card(for: t, among: [t], excluded: f.taskExcluded["t:1"] ?? [])?.discussionSummary == "1 of 2 messages")
        f.setIncluded("p5", true, task: "t:1")
        #expect(f.includeToSend(taskId: "t:1", action: .go(sessionId: nil)) == nil)
        f.setIncluded("p0", false, task: "t:1")
        // Once the Task is taken up the trim is forgotten.
        f.upsert(job: job("t:1", state: .working, updated: 5))
        #expect(f.taskExcluded["t:1"] == nil)
    }

    @Test func bodiesCarryTheTrimAndDropIsStrict() {
        #expect(RoomTaskAction.drop.body == .object(["action": .string("drop")]))
        #expect(RoomTaskAction.newThread.body(place: nil, include: ["a", "b"]) == .object(["action": .string("new"), "messageIds": .array([.string("a"), .string("b")])]))
        #expect(RoomTaskAction.drop.body(place: nil, include: ["a"]) == .object(["action": .string("drop")]))
    }

    @Test func aSuggestionMayBeTakenUpAndADroppedTaskMadeAgain() {
        let row = RoomRow(id: "p1", post: personPost(1), pending: false, failed: false)
        #expect(RoomTasks.canMakeTask(row, jobs: [job(proposed: true)]))
        #expect(!RoomTasks.canMakeTask(row, jobs: [job(state: .working)]))
    }
}
