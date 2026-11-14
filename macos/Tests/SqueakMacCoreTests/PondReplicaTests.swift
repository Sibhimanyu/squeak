import XCTest
@testable import SqueakMacCore

/// A member reading someone else's thread through a pond reduces the same events, to the same timeline.
final class PondReplicaTests: XCTestCase {
    private let owner = TimelineAuthor(id: "m1", name: "Sibhi")

    /// The owner's timeline as the pond carries it: prompts the owner typed name the owner (the bridge fills that in).
    private func relayed() -> [TimelineEvent] {
        Log.busyChat().map { e in
            guard case .turnStarted(let t, let p, _, let text, let author, let q, let auto) = e.body else { return e }
            return TimelineEvent(seq: e.seq, at: e.at, body: .turnStarted(
                turnId: t, promptMessageId: p, clientNonce: nil, text: text, author: author ?? owner, queuedId: q, auto: auto))
        }
    }

    /// Each timeline event as a pond event, in the pond's own numbering, with other kinds of event between them.
    private func pond(_ events: [TimelineEvent]) -> [ThreadEvent] {
        var out: [ThreadEvent] = []
        var n = 0
        for e in events {
            n += 1
            out.append(ThreadEvent(seq: 100 + n, at: e.at, kind: .timeline(e)))
            if e.seq % 7 == 0 { n += 1; out.append(ThreadEvent(seq: 100 + n, kind: .state("working"))) }
        }
        return out
    }

    func testAGuestReplicaConvergesToTheOwnersTimelineWhateverTheArrival() {
        let events = relayed()
        let truth = Log.timeline(events)
        let wire = pond(events)
        for seed in 1...200 {
            var rng = SplitMix(state: UInt64(seed))
            var replica = PondReplica()
            // Pages of random size and order, with copies, as reads after reconnects would give.
            var pending = wire
            pending += wire.filter { _ in Int.random(in: 0..<3, using: &rng) == 0 }
            pending.shuffle(using: &rng)
            while !pending.isEmpty {
                let n = min(pending.count, Int.random(in: 1...9, using: &rng))
                replica.ingest(Array(pending.prefix(n)))
                pending.removeFirst(n)
            }
            replica.settle()
            XCTAssertEqual(replica.timeline, truth, "seed \(seed)")
        }
    }

    func testPromptLabelsAreSetOnceAndNeverFlickerWhileEventsArrive() {
        let wire = pond(relayed())
        var replica = PondReplica()
        var seen: [String: String?] = [:]
        for e in wire {
            // A read at a time, each ending with the pond fully read.
            replica.ingest([e])
            replica.settle()
            for row in replica.rows(starter: "m1") {
                guard case .user(_, let by, let text, _) = row else { continue }
                if let was = seen[text] { XCTAssertEqual(was, by, "\(text): the author never changes under the reader") }
                seen[text] = by
            }
        }
        XCTAssertEqual(seen["fix the bug"], "m1")
        XCTAssertEqual(seen["also add a test"], "m2")
        // On Aarav's own Mac his prompt is his own (no label); the owner's carries the owner's name.
        let turns = replica.timeline.turns
        XCTAssertEqual(TimelineLabels.author(turns[0].author, me: "m2"), "Sibhi")
        XCTAssertNil(TimelineLabels.author(turns[1].author, me: "m2"))
    }

    func testRowsKeepTheirIdsAsTheThreadGrows() {
        let wire = pond(relayed())
        var replica = PondReplica()
        var ids: [Int] = []
        for e in wire {
            replica.ingest([e])
            replica.settle()
            // Words never go and never move. (A finished turn's several runs of work fold into one, which is the one
            // structural change a turn makes, once, when it ends.)
            let now = replica.rows(starter: "m1").filter { if case .steps = $0 { false } else { true } }.map(\.id)
            XCTAssertEqual(Array(now.prefix(ids.count)), ids, "a row that was shown is still there, in its place")
            ids = now
        }
        XCTAssertEqual(Set(ids).count, ids.count, "no two rows share an id")
    }

    func testQuestionsAndChangesStayInThePondsOrderBetweenTheTimelinesRows() {
        let events = relayed()
        var wire = pond(events)
        let last = wire.last!.seq
        wire.append(ThreadEvent(seq: last + 1, kind: .question(requestId: "r1", text: "Which one?", options: ["A", "B"])))
        wire.append(ThreadEvent(seq: last + 2, kind: .changed(files: 2, added: 5, removed: 1, paths: ["a.ts"])))
        var replica = PondReplica()
        replica.ingest(wire)
        replica.settle()
        let rows = ThreadTimeline.rows(wire, replica: replica, starter: "m1")
        XCTAssertEqual(rows.map(\.id), rows.map(\.id).sorted())
        guard case .question = rows[rows.count - 2], case .changed = rows[rows.count - 1] else { return XCTFail("the pond's own rows come last, in order") }
    }

    func testAHostSeqThatWasNeverRelayedIsSteppedOverOnSettle() {
        let events = relayed()
        let wire = pond(events.filter { $0.seq != 6 })
        var replica = PondReplica()
        let split = wire.firstIndex { if case .timeline(let t) = $0.kind { t.seq == 7 } else { false } }!
        replica.ingest(Array(wire[..<split]))
        replica.settle()
        replica.ingest(Array(wire[split...]))
        XCTAssertNotNil(replica.timeline.gapSince, "events wait behind the missing one")
        let held = replica.rows(starter: "m1").count
        replica.settle()
        XCTAssertNil(replica.timeline.gapSince)
        XCTAssertGreaterThan(replica.rows(starter: "m1").count, held)
        XCTAssertEqual(replica.timeline.lastSeq, events.last!.seq)
    }

    func testOwnerAndGuestSeeTheSameTurnsInTheSameOrder() {
        let events = relayed()
        let owners = Log.timeline(events)
        var replica = PondReplica()
        replica.ingest(pond(events))
        replica.settle()
        XCTAssertEqual(replica.timeline.turns.map(\.turnId), owners.turns.map(\.turnId))
        XCTAssertEqual(replica.timeline.turns.map(\.prompt), ["fix the bug", "also add a test", "try again"])
        XCTAssertEqual(replica.timeline.turns.map(\.author?.name), ["Sibhi", "Aarav", "Sibhi"])
    }

    func testDecodesATimelineEventFromAPondEventAndIgnoresOneItCannotRead() throws {
        let json = """
        {"events":[
          {"seq":7,"at":1800000000000,"type":"timeline","ev":{"seq":3,"type":"turn.ended","turnId":"t1","outcome":"done","at":"2026-11-14T10:00:00.000Z"}},
          {"seq":8,"at":1800000000000,"type":"timeline","ev":{"nonsense":1}},
          {"seq":9,"at":1800000000000,"type":"agent","text":"older kind still reads"}
        ],"lastSeq":9}
        """
        let page = try JSONDecoder().decode(ThreadEventPage.self, from: Data(json.utf8))
        XCTAssertEqual(page.events.count, 3)
        guard case .timeline(let e) = page.events[0].kind else { return XCTFail("timeline") }
        XCTAssertEqual(e.seq, 3)
        guard case .other = page.events[1].kind else { return XCTFail("an unreadable one is `other`") }
        guard case .agent = page.events[2].kind else { return XCTFail("agent") }
    }
}
