import Foundation
import Testing

@testable import SqueakMacCore

@Suite("Pond room ripples")
struct RoomRipplesTests {
    private var cal: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!; return c }
    private let min: Int64 = 60_000
    private let base: Int64 = (1_780_000_000_000 / 86_400_000) * 86_400_000 + 3_600_000  // 01:00 UTC on a fixed day
    private var now: Date { Date(timeIntervalSince1970: Double(base + 600 * min) / 1000) }

    private func turn(_ id: String, _ s: String = "s1", at: Int64, ended: Int64? = nil, outcome: RoomTurnOutcome? = .finished, prompt: String = "do it", me: Bool = true, answer: RoomTurnAnswer? = nil, text: String? = "Done.", files: Int? = 2, intent: String? = nil, progress: RoomProgress? = nil) -> RoomTurn {
        RoomTurn(id: id, sessionId: s, threadTitle: "T-\(s)", startedAt: at, endedAt: ended ?? (outcome == nil ? nil : at + min), outcome: outcome, prompt: prompt,
                 author: RoomTurnAuthor(name: "Sibhi", me: me), answer: answer, outcomeText: text, durationMs: outcome == nil ? nil : 100_000, filesChanged: files, intent: intent, progress: progress)
    }
    private func feed(turns: [RoomTurn], posts: [RoomPost] = [], threads: [RoomThread] = [], serves: Bool = true) -> RoomFeed {
        var f = RoomFeed()
        f.apply(page: RoomPage(posts: posts, latestSeq: posts.map(\.seq).max() ?? 0, threads: threads, turns: serves ? turns : nil))
        return f
    }
    private func post(_ seq: Int, _ text: String, kind: RoomPostKind = .message, level: RoomLevel = .room, by: RoomAuthor, at: Int64, sid: String? = nil, to: String? = nil) -> RoomPost {
        RoomPost(seq: seq, id: "p\(seq)", author: by, sessionId: sid, kind: kind, level: level, text: text, toSessionId: to, at: at)
    }

    @Test func turnUpsertsInPlaceAndKeepsItsPlace() {
        var f = feed(turns: [turn("a", at: base), turn("b", "s2", at: base + 5 * min, outcome: nil, intent: "Working")])
        f.upsert(turn: turn("b", "s2", at: base + 5 * min, outcome: .finished))
        f.upsert(turn: turn("c", at: base + 3 * min))
        #expect(f.turns.map(\.id) == ["a", "c", "b"])
        #expect(f.turns.last?.outcome == .finished)
        f.upsert(turn: turn("c", at: base + 3 * min, text: "again"))
        #expect(f.turns.count == 3)
    }

    @Test func groupsConsecutiveTurnsOfOneThreadWithinFifteenMinutes() {
        let f = feed(turns: [turn("a", at: base), turn("b", at: base + 14 * min), turn("c", at: base + 60 * min), turn("d", "s2", at: base + 61 * min)])
        let r = RoomRipples.build(feed: f, filter: .all, now: now, calendar: cal)
        let groups = r.compactMap { if case .threadTurns(let g) = $0 { g } else { nil } }
        #expect(groups.map { $0.rows.map(\.id) } == [["a", "b"], ["c"], ["d"]])
        #expect(groups[0].countLabel == "2 turns" && groups[1].countLabel == "1 turn")
        // Appending a turn to the tail never changes an existing group's id.
        var g = f
        g.upsert(turn: turn("e", "s2", at: base + 70 * min))
        let again = RoomRipples.build(feed: g, filter: .all, now: now, calendar: cal)
        #expect(again.map(\.id).prefix(r.count) == r.map(\.id)[...])
    }

    @Test func aPersonMessageBreaksAGroupAndDaySeparatorsLead() {
        let me = RoomAuthor(kind: .person, name: "You")
        let f = feed(turns: [turn("a", at: base), turn("b", at: base + 5 * min)], posts: [post(1, "hello", by: me, at: base + 2 * min)])
        let r = RoomRipples.build(feed: f, filter: .all, now: now, calendar: cal)
        guard case .day(_, let label) = r[0] else { Issue.record("no day"); return }
        #expect(label == "Today")
        #expect(r.count == 4)
        if case .bubble(_, let mine) = r[2] { #expect(mine) } else { Issue.record("no bubble") }
    }

    @Test func answerLineNamesTheLetterAndQuestion() {
        let t = turn("a", at: base, answer: RoomTurnAnswer(letter: "C", question: "Which approach?"))
        #expect(RoomRipples.promptLine(t) == .answered(who: "You", letter: "C", question: "Which approach?"))
        let other = turn("b", at: base, prompt: "go", me: false)
        #expect(RoomRipples.promptLine(other) == .said(name: "Sibhi", quote: "go"))
        #expect(RoomRipples.promptLine(turn("c", at: base, prompt: " ")) == nil)
    }

    @Test func outcomeAndMetaLines() {
        #expect(RoomRipples.outcomeLine(turn("a", at: base, outcome: nil, intent: "Adding a toggle"), asking: false) == RoomOutcomeLine(mark: .working, text: "Adding a toggle"))
        #expect(RoomRipples.outcomeLine(turn("a", at: base, outcome: nil, text: "Asked how it fits."), asking: true).text == "Asked how it fits. Waiting on you.")
        #expect(RoomRipples.outcomeLine(turn("a", at: base, outcome: .error, text: nil), asking: false).mark == .failed)
        #expect(RoomRipples.duration(ms: 14_000) == "14 s" && RoomRipples.duration(ms: 100_000) == "1m 40s" && RoomRipples.duration(ms: 128_000) == "2m 08s")
        let running = turn("a", at: base, outcome: nil, files: nil, progress: RoomProgress(current: 3, total: 5))
        #expect(RoomRipples.metaLine(running, asking: false, now: now) == "step 3 of 5")
        #expect(RoomRipples.metaLine(turn("a", at: base, files: 3), asking: false, now: now) == "1m 40s \u{00B7} 3 files")
        #expect(RoomRipples.metaLine(turn("a", at: base, files: nil), asking: false, now: now) == "1m 40s")
    }

    @Test func askingRowIsTheLatestRunningTurnOfAWaitingThread() {
        let threads = [RoomThread(sessionId: "s1", title: "T", state: .waiting, ask: RoomAsk(question: "Q?", options: [RoomAskOption(letter: "A", text: "x")]))]
        let f = feed(turns: [turn("a", at: base), turn("b", at: base + 2 * min, outcome: nil, text: nil)], threads: threads)
        let r = RoomRipples.build(feed: f, filter: .needsYou, now: now, calendar: cal)
        let rows = r.compactMap { if case .threadTurns(let g) = $0 { g.rows } else { nil } }.flatMap { $0 }
        #expect(rows.map(\.id) == ["b"] && rows[0].asking && rows[0].outcome.mark == .attention)
    }

    @Test func filters() {
        let me = RoomAuthor(kind: .person, name: "You")
        let agent = RoomAuthor(kind: .agent, id: "x", name: "A")
        let posts = [post(1, "hi", by: me, at: base + min), post(2, "I changed the layout (holds src/**)", kind: .handoff, level: .agents, by: agent, at: base + 2 * min, sid: "s1", to: "s2")]
        let threads = [RoomThread(sessionId: "s1", title: "One", state: .idle), RoomThread(sessionId: "s2", title: "Two", state: .idle)]
        let f = feed(turns: [turn("a", at: base)], posts: posts, threads: threads)
        func kinds(_ fl: RoomRippleFilter) -> [String] {
            RoomRipples.build(feed: f, filter: fl, now: now, calendar: cal).map {
                switch $0 { case .day: "day"; case .threadTurns: "turns"; case .bubble: "bubble"; case .handoff: "handoff"; case .event: "event"; case .jobLine: "job" }
            }
        }
        #expect(kinds(.all) == ["day", "turns", "bubble", "handoff"])
        #expect(kinds(.people) == ["day", "bubble"])
        #expect(kinds(.agents) == ["day", "turns", "handoff"])
        #expect(kinds(.needsYou) == [])
        let h = RoomRipples.build(feed: f, filter: .agents, now: now, calendar: cal).compactMap { if case .handoff(let h) = $0 { h } else { nil } }.first
        #expect(h?.fromTitle == "One" && h?.toTitle == "Two" && h?.scope == "holds src/**" && h?.quote == "I changed the layout")
    }

    @Test func fallsBackToPostsWithoutTurns() {
        let agent = RoomAuthor(kind: .agent, id: "x", name: "Claude")
        let f = feed(turns: [], posts: [post(1, "Adding a toggle", kind: .working, by: agent, at: base, sid: "s1"), post(2, "Done", kind: .done, by: agent, at: base + min, sid: "s1")],
                     threads: [RoomThread(sessionId: "s1", title: "One", state: .idle)], serves: false)
        #expect(!f.servesTurns)
        let r = RoomRipples.build(feed: f, filter: .all, now: now, calendar: cal)
        #expect(r.count == 3)
        if case .event(_, let title, _) = r[1] { #expect(title == "One") } else { Issue.record("no event") }
    }

    @Test func mineStaysRightAfterTheHostCopyReplacesThePendingRow() {
        var f = RoomFeed()
        f.apply(page: RoomPage(posts: [], latestSeq: 0, threads: [], turns: []))
        let id = f.addPending(text: "hello", level: .room, author: RoomAuthor(kind: .person, name: "You"), at: base)
        f.reconcile(pendingId: id, with: post(1, "hello", by: RoomAuthor(kind: .person, id: "u1", name: "Sibhi Raj"), at: base))
        let r = RoomRipples.build(feed: f, filter: .all, now: now, calendar: cal)
        if case .bubble(let row, let mine) = r.last { #expect(mine && row.id == id) } else { Issue.record("no bubble") }
    }

    @Test func nowCardsAreNewestStartFirstWithQuestionsLeading() {
        let q = RoomAsk(question: "Q?", options: [RoomAskOption(letter: "A", text: "x")])
        let threads = [
            RoomThread(sessionId: "a", title: "A", state: .working, turnStartedAt: base),
            RoomThread(sessionId: "b", title: "B", state: .working, workingOnAt: base + 99 * min, turnStartedAt: base + 5 * min),
            RoomThread(sessionId: "c", title: "C", state: .waiting, ask: q, turnStartedAt: base - 10 * min),
            RoomThread(sessionId: "d", title: "D", state: .idle, lastAt: base),
            RoomThread(sessionId: "e", title: "E", state: .idle, lastAt: base + 9 * min),
        ]
        let cards = RoomNow.cards(threads: threads, unread: ["e"], now: now, filesFor: { $0 == "a" ? 4 : nil })
        #expect(cards.map(\.id) == ["c", "e", "b", "a"])
        #expect(cards[0].fullWidth && cards[0].kind == .needsYou)
        #expect(cards[3].meta.hasSuffix("4 files"))
        #expect(RoomNow.cards(threads: threads, unread: [], now: now).count == 3)
    }

    @Test func summaryAndToday() {
        let working = feed(turns: [], threads: [RoomThread(sessionId: "a", title: "A", state: .working), RoomThread(sessionId: "b", title: "B", state: .waiting)])
        #expect(RoomSummary.line(feed: working, now: now) == .init(working: 1, needsYou: 1, quiet: false, quietDetail: nil))
        let quiet = feed(turns: [turn("a", at: base)], threads: [RoomThread(sessionId: "a", title: "A", state: .idle, lastAt: base + 598 * min)])
        #expect(RoomSummary.line(feed: quiet, now: now).quietDetail == "last activity 2 min ago")
        let t = RoomSummary.today(turns: [turn("a", at: base, files: 3), turn("b", "s2", at: base + min, files: nil)], now: now, calendar: cal)
        #expect(t == .init(turns: 2, files: 3, threads: 2))
    }

    @Test func mentionParsingAndCandidates() {
        #expect(RoomMention.active(in: "hello @gre")?.query == "gre")
        #expect(RoomMention.active(in: "mail a@b") == nil)
        #expect(RoomMention.active(in: "@gre done") == nil)
        #expect(RoomMention.active(in: "@")?.query == "")
        let threads = [RoomThread(sessionId: "a", title: "Greeting Exchange", state: .working), RoomThread(sessionId: "b", title: "Edit Feature", state: .idle)]
        let c = RoomMention.candidates(query: "ex", threads: threads, people: ["Priya Nair", "Exa"])
        #expect(c.map(\.id) == ["t:a", "p:Exa"])
        let a = RoomMention.active(in: "hi @gre")!
        #expect(RoomMention.removing(a, from: "hi @gre") == "hi ")
        #expect(RoomMention.roomText("look", to: .person(name: "Priya")) == "@Priya look")
    }

    @Test func decodesV2LenientlyAndOlderHosts() throws {
        let json = """
        {"posts":[],"latestSeq":0,"threads":[{"sessionId":"s","title":"T","state":"waiting","progress":{"current":2,"total":3,"label":"x"},
          "ask":{"question":"Q?","options":[{"letter":"A","text":"one","recommended":true},{"nope":1}]},"turnStartedAt":5,"filesChanged":2,"extra":1}],
         "turns":[{"id":"s:1","sessionId":"s","threadTitle":"T","agent":"claude","startedAt":10,"prompt":"p","author":{"kind":"person","name":"Sibhi","me":true},"answer":{"letter":"C","question":"Q"}},{"bad":1}]}
        """
        let page = try JSONDecoder().decode(RoomPage.self, from: Data(json.utf8))
        #expect(page.turns?.count == 1 && page.turns?[0].author.me == true && page.turns?[0].outcome == nil && page.turns?[0].answer?.letter == "C")
        #expect(page.threads[0].ask?.options.count == 1 && page.threads[0].ask?.options[0].recommended == true)
        #expect(page.threads[0].progress == RoomProgress(current: 2, total: 3, label: "x") && page.threads[0].turnStartedAt == 5)
        let old = try JSONDecoder().decode(RoomPage.self, from: Data(#"{"posts":[],"latestSeq":0,"threads":[]}"#.utf8))
        #expect(old.turns == nil)
        var f = RoomFeed(); f.apply(page: old)
        #expect(!f.servesTurns)
    }
}
