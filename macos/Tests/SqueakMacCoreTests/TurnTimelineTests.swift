import XCTest
@testable import SqueakMacCore

/// A small deterministic generator, so a failing interleaving can be replayed from its seed.
struct SplitMix: RandomNumberGenerator {
    var state: UInt64
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

enum Log {
    static let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    static func at(_ n: Int) -> Date { t0.addingTimeInterval(TimeInterval(n)) }

    static func start(_ seq: Int, _ turn: String, _ text: String, nonce: String? = nil, author: TimelineAuthor? = nil, queued: String? = nil) -> TimelineEvent {
        TimelineEvent(seq: seq, at: at(seq), body: .turnStarted(
            turnId: turn, promptMessageId: "native-\(turn.dropFirst())", clientNonce: nonce, text: text, author: author, queuedId: queued, auto: false))
    }
    static func step(_ seq: Int, _ turn: String, _ id: String, _ kind: TimelineStepKind = .tool, _ label: String = "Run ls",
                     _ status: TimelineStepStatus = .running, detail: [String: NativeJSON] = [:]) -> TimelineEvent {
        TimelineEvent(seq: seq, at: at(seq), body: .step(TimelineStepEvent(turnId: turn, stepId: id, kind: kind, label: label, detail: detail, status: status)))
    }
    static func reply(_ seq: Int, _ turn: String, _ id: String, _ text: String) -> TimelineEvent {
        TimelineEvent(seq: seq, at: at(seq), body: .replyDone(turnId: turn, messageId: id, blockKey: nil, text: text))
    }
    static func end(_ seq: Int, _ turn: String, _ outcome: TimelineOutcome = .done, reply: String? = nil, error: String? = nil) -> TimelineEvent {
        TimelineEvent(seq: seq, at: at(seq), body: .turnEnded(turnId: turn, outcome: outcome, error: error, replyMessageId: reply))
    }
    static func queued(_ seq: Int, _ id: String, _ text: String, author: TimelineAuthor? = nil, nonce: String? = nil) -> TimelineEvent {
        TimelineEvent(seq: seq, at: at(seq), body: .promptQueued(queuedId: id, text: text, author: author, clientNonce: nonce))
    }
    static func dequeued(_ seq: Int, _ id: String) -> TimelineEvent { TimelineEvent(seq: seq, at: at(seq), body: .promptDequeued(queuedId: id)) }

    static let aarav = TimelineAuthor(id: "m2", name: "Aarav")

    /// Two people taking turns in one chat: tool calls updated in place, thoughts, notes, a reply, a failure, a stop,
    /// a prompt queued behind a running turn and then started, and a queued prompt that was taken back out.
    static func busyChat() -> [TimelineEvent] {
        var e: [TimelineEvent] = []
        func add(_ make: (Int) -> TimelineEvent) { e.append(make(e.count + 1)) }
        add { start($0, "t1", "fix the bug") }
        add { step($0, "t1", "m1:0", .thinking, "Thinking…", .running) }
        add { step($0, "t1", "m1:0", .thinking, "look at the parser", .done, detail: ["text": .string("look at the parser first")]) }
        add { step($0, "t1", "tu1", .tool, "Reading a file", .running) }
        add { step($0, "t1", "tu1", .tool, "Read parser.ts", .running) }
        add { step($0, "t1", "tu1", .tool, "Read parser.ts", .done) }
        add { step($0, "t1", "wait-1", .waiting, "Waiting for Claude", .running, detail: ["since": .number(1_800_000_006_000)]) }
        add { step($0, "t1", "wait-1", .waiting, "Waiting for Claude", .done) }
        add { reply($0, "t1", "native-8", "I found it, fixing now.") }
        add { step($0, "t1", "tu2", .tool, "Edit parser.ts", .running) }
        add { queued($0, "q1", "also add a test", author: aarav) }
        add { step($0, "t1", "tu2", .tool, "Edit parser.ts", .done) }
        add { reply($0, "t1", "native-13", "Fixed.") }
        add { end($0, "t1", reply: "native-13") }
        add { start($0, "t14", "also add a test", author: aarav, queued: "q1") }
        add { step($0, "t14", "tu3", .tool, "Write parser.test.ts", .running) }
        add { step($0, "t14", "tu3", .tool, "Write parser.test.ts", .failed) }
        add { end($0, "t14", .failed, error: "Couldn't reach Claude") }
        add { queued($0, "q2", "never mind") }
        add { dequeued($0, "q2") }
        add { start($0, "t21", "try again") }
        add { step($0, "t21", "tu4", .tool, "Run npm test", .running) }
        add { end($0, "t21", .stopped) }
        return e
    }

    /// The first `n` events with the queued prompt left out (its seq kept), for tests of a press on a chat nobody else is waiting in.
    static func busyChat(withoutQueue n: Int) -> [TimelineEvent] {
        busyChat().prefix(n).map { e in
            if case .promptQueued = e.body { TimelineEvent(seq: e.seq, at: e.at, body: .unknown("queued")) } else { e }
        }
    }

    static func timeline(_ events: [TimelineEvent]) -> TurnTimeline {
        var t = TurnTimeline()
        t.load(events)
        return t
    }
}

final class TurnTimelineTests: XCTestCase {
    func testInOrderBuildsTheTurnsOnce() {
        let t = Log.timeline(Log.busyChat())
        XCTAssertEqual(t.turns.map(\.turnId), ["t1", "t14", "t21"])
        XCTAssertEqual(t.lastSeq, 23)
        XCTAssertNil(t.gapSince)
        let first = t.turns[0]
        XCTAssertEqual(first.state, .ended(.done))
        XCTAssertEqual(first.steps.map(\.id), ["m1:0", "tu1", "wait-1", "native-8", "tu2", "native-13"])
        // A tool is one step however many events updated it, and keeps its place.
        XCTAssertEqual(first.steps.first { $0.id == "tu1" }?.label, "Read parser.ts")
        XCTAssertEqual(first.steps.first { $0.id == "tu1" }?.status, .done)
        XCTAssertEqual(first.reply?.label, "Fixed.")
        XCTAssertEqual(first.listedSteps.map(\.id), ["m1:0", "tu1", "native-8", "tu2"])
        XCTAssertEqual(t.turns[1].author, Log.aarav)
        XCTAssertEqual(t.turns[1].state, .ended(.failed))
        XCTAssertEqual(t.turns[1].error, "Couldn't reach Claude")
        XCTAssertEqual(t.turns[2].state, .ended(.stopped))
        XCTAssertEqual(t.turns[2].steps.first?.status, .done)
        XCTAssertTrue(t.queued.isEmpty, "a queued prompt leaves the queue by starting or by being taken out, once")
    }

    func testAnyOrderAndAnyCopiesConvergeToTheSameTimeline() {
        let log = Log.busyChat()
        let truth = Log.timeline(log)
        for seed in 1...300 {
            var rng = SplitMix(state: UInt64(seed))
            var stream = log
            // duplicates and replays: some events twice, a whole prefix again
            for e in log where Int.random(in: 0..<4, using: &rng) == 0 { stream.append(e) }
            if seed % 5 == 0 { stream += log.prefix(Int.random(in: 1...log.count, using: &rng)) }
            stream.shuffle(using: &rng)
            // the page that sets where the log starts arrives first, as a first read does
            var t = TurnTimeline()
            t.load([log[0]])
            for e in stream { t.apply(e) }
            XCTAssertEqual(t, truth, "seed \(seed)")
            XCTAssertNil(t.gapSince)
        }
    }

    func testEventsBeforeTheFirstPageAreHeldNotLost() {
        let log = Log.busyChat()
        var t = TurnTimeline()
        for e in log.suffix(8) { t.apply(e) }
        XCTAssertTrue(t.turns.isEmpty)
        t.load(Array(log.prefix(15)))
        XCTAssertEqual(t, Log.timeline(log))
    }

    func testADroppedEventShowsAGapAndTheRefetchClosesIt() {
        let log = Log.busyChat()
        let truth = Log.timeline(log)
        for seed in 1...100 {
            var rng = SplitMix(state: UInt64(seed))
            let dropped = Set((1..<log.count).filter { _ in Int.random(in: 0..<5, using: &rng) == 0 })
            guard let firstMissing = dropped.min(), log.indices.contains(where: { $0 > firstMissing && !dropped.contains($0) }) else { continue }
            var t = Log.timeline([log[0]])
            var asked: [Int] = []
            for (i, e) in log.enumerated() where i > 0 && !dropped.contains(i) {
                if case .held(let since) = t.apply(e) { asked.append(since) }
            }
            // index = seq - 1, so the events held up to the first missing one number `firstMissing` of them
            XCTAssertEqual(t.gapSince, firstMissing, "seed \(seed): asks for events after the last contiguous one")
            XCTAssertFalse(asked.isEmpty)
            // The refetch: everything after what the timeline holds, delivered in one page.
            t.load(log.filter { $0.seq > t.lastSeq })
            XCTAssertEqual(t, truth, "seed \(seed)")
        }
    }

    func testAGapTheLogCannotFillIsAcceptedOnRequest() {
        let log = Log.busyChat()
        var t = Log.timeline(Array(log.prefix(3)))
        for e in log.suffix(10) { t.apply(e) }
        XCTAssertNotNil(t.gapSince)
        t.acceptGap()
        XCTAssertNil(t.gapSince)
        XCTAssertEqual(t.lastSeq, log.last!.seq)
    }

    func testRowsNeverDisappearAndEndedTurnsNeverChange() {
        let log = Log.busyChat()
        var t = TurnTimeline()
        t.load([log[0]])
        var seenTurns: [String] = []
        var stepIds: [String: [String]] = [:]
        var ended: [String: TimelineTurn] = [:]
        for e in log.dropFirst() {
            t.apply(e)
            let ids = t.turns.compactMap(\.turnId)
            XCTAssertEqual(Array(ids.prefix(seenTurns.count)), seenTurns, "turns keep their places")
            seenTurns = ids
            for turn in t.turns {
                guard let id = turn.turnId else { continue }
                let steps = turn.steps.map(\.id)
                XCTAssertEqual(Array(steps.prefix(stepIds[id]?.count ?? 0)), stepIds[id] ?? [], "steps keep their places and never go")
                stepIds[id] = steps
                if let was = ended[id] { XCTAssertEqual(turn, was, "an ended turn never changes") }
                if turn.isEnded, ended[id] == nil { ended[id] = turn }
            }
        }
        // Late word about an ended turn, however it arrives, changes nothing.
        let before = t
        t.apply(Log.step(24, "t1", "tu9", .tool, "Run rm", .running))
        t.apply(Log.reply(25, "t1", "native-99", "ghost"))
        t.apply(Log.end(26, "t14", .done))
        XCTAssertEqual(t.turns, before.turns)
    }

    func testANewPromptNeverShowsThePreviousTurnsWork() {
        var t = Log.timeline(Log.busyChat(withoutQueue: 14))
        let old = t.turns[0]
        XCTAssertEqual(old.listedSteps.count, 4)
        // The person presses Send: a row at once, with nothing under it.
        t.send(nonce: "n1", text: "now do the next thing", at: Log.at(100))
        XCTAssertEqual(t.turns.count, 2)
        XCTAssertTrue(t.turns[1].steps.isEmpty)
        XCTAssertEqual(t.turns[1].state, .sending)
        XCTAssertEqual(t.turns[0], old, "the previous turn is exactly as it was")
        // Anything still arriving for the old turn goes nowhere near the new one.
        t.apply(Log.step(15, "t1", "late", .tool, "Run ls", .running))
        XCTAssertTrue(t.turns[1].steps.isEmpty)
        // The host names the new turn; only its own steps attach to it.
        t.apply(Log.start(16, "t16", "now do the next thing", nonce: "n1"))
        t.apply(Log.step(17, "t16", "tuX", .tool, "Run date", .running))
        XCTAssertEqual(t.turns[1].steps.map(\.id), ["tuX"])
        XCTAssertEqual(t.turns[0], old)
    }

    func testAPressIsReconciledInPlaceWithNoSecondRow() {
        var t = Log.timeline(Log.busyChat(withoutQueue: 14))
        t.send(nonce: "n1", text: "again", at: Log.at(100))
        let key = t.turns[1].id
        let count = t.turns.count
        t.apply(Log.start(15, "t15", "again", nonce: "n1"))
        XCTAssertEqual(t.turns.count, count)
        XCTAssertEqual(t.turns[1].id, key, "the row keeps its key, so the view never swaps it")
        XCTAssertEqual(t.turns[1].turnId, "t15")
        XCTAssertEqual(t.turns[1].state, .running)
        // A second copy of the event, or a replay, changes nothing.
        let once = t
        t.apply(Log.start(15, "t15", "again", nonce: "n1"))
        XCTAssertEqual(t, once)
    }

    func testAPressWhoseNonceWasLostStillMeetsItsTurn() {
        var t = Log.timeline(Log.busyChat(withoutQueue: 14))
        t.send(nonce: "n1", text: "later", at: Log.at(100))
        t.apply(Log.start(15, "t15", "later"))
        XCTAssertEqual(t.turns.count, 2)
        // …but never a teammate's words, even if they match.
        var u = Log.timeline(Log.busyChat(withoutQueue: 14))
        u.send(nonce: "n1", text: "later", at: Log.at(100))
        u.apply(Log.start(15, "t15", "later", author: Log.aarav))
        XCTAssertEqual(u.turns.count, 3)
        XCTAssertEqual(u.turns[1].turnId, "t15", "the teammate's turn is above our press")
        XCTAssertEqual(u.turns[2].state, .sending)
    }

    func testTwoPeoplePromptingAtOnceFollowTheHostsOrder() {
        // We pressed Send; Aarav's prompt reached the host first. The host's order wins, and our row keeps its place after.
        var t = Log.timeline([Log.start(1, "t1", "first"), Log.end(2, "t1")])
        t.send(nonce: "mine", text: "mine", at: Log.at(50))
        t.apply(Log.start(3, "t3", "from aarav", author: Log.aarav))
        XCTAssertEqual(t.turns.map(\.prompt), ["first", "from aarav", "mine"])
        let mineKey = t.turns[2].id
        t.apply(Log.end(4, "t3"))
        t.apply(Log.start(5, "t5", "mine", nonce: "mine"))
        XCTAssertEqual(t.turns.map(\.prompt), ["first", "from aarav", "mine"])
        XCTAssertEqual(t.turns[2].id, mineKey)
        XCTAssertEqual(t.turns.map(\.turnId), ["t1", "t3", "t5"])
    }

    func testAQueuedPromptShowsUnderItsAuthorAndMovesIntoPlaceOnce() {
        var t = Log.timeline([Log.start(1, "t1", "first")])
        t.apply(Log.queued(2, "q1", "from aarav", author: Log.aarav))
        XCTAssertEqual(t.queued.map(\.text), ["from aarav"])
        XCTAssertEqual(t.queued.first?.author, Log.aarav)
        XCTAssertEqual(t.turns.count, 2, "a waiting prompt is a dimmed row at the end of the transcript")
        XCTAssertEqual(t.turns[1].state, .queued)
        XCTAssertEqual(t.turns[1].author, Log.aarav)
        t.apply(Log.end(3, "t1"))
        t.apply(Log.start(4, "t4", "from aarav", author: Log.aarav, queued: "q1"))
        XCTAssertTrue(t.queued.isEmpty)
        XCTAssertEqual(t.turns.map(\.prompt), ["first", "from aarav"])
        t.apply(Log.start(4, "t4", "from aarav", author: Log.aarav, queued: "q1"))
        XCTAssertEqual(t.turns.count, 2)
    }

    func testAQueuedRowKeepsItsIdAndPlaceWhenItStarts() {
        var t = Log.timeline([Log.start(1, "t1", "first")])
        t.apply(Log.queued(2, "q1", "from aarav", author: Log.aarav))
        let id = t.turns[1].id
        XCTAssertEqual(t.current?.turnId, "t1", "the waiting row is never the current turn")
        t.apply(Log.end(3, "t1"))
        t.apply(Log.start(4, "t4", "from aarav", author: Log.aarav, queued: "q1"))
        XCTAssertEqual(t.turns.count, 2)
        XCTAssertEqual(t.turns[1].id, id)
        XCTAssertEqual(t.turns[1].turnId, "t4")
        XCTAssertEqual(t.turns[1].state, .running)
        XCTAssertNotEqual(t.turns[1].promptMessage()?.state, .pending, "started: no longer dimmed")
    }

    func testARemovedQueuedRowDisappears() {
        var t = Log.timeline([Log.start(1, "t1", "first")])
        t.apply(Log.queued(2, "q1", "never mind", author: Log.aarav))
        XCTAssertEqual(t.turns.count, 2)
        t.apply(Log.dequeued(3, "q1"))
        XCTAssertEqual(t.turns.map(\.turnId), ["t1"])
        XCTAssertTrue(t.queued.isEmpty)
    }

    func testTwoAuthorsQueuedRowsStayInSeqOrder() {
        var t = Log.timeline([Log.start(1, "t1", "first")])
        t.apply(Log.queued(2, "q1", "from aarav", author: Log.aarav))
        t.apply(Log.queued(3, "q2", "from me"))
        XCTAssertEqual(t.turns.map(\.prompt), ["first", "from aarav", "from me"])
        XCTAssertEqual(t.turns.map(\.author), [nil, Log.aarav, nil])
        t.apply(Log.end(4, "t1"))
        t.apply(Log.start(5, "t5", "from aarav", author: Log.aarav, queued: "q1"))
        XCTAssertEqual(t.turns.map(\.prompt), ["first", "from aarav", "from me"])
        XCTAssertEqual(t.turns.map(\.state), [.ended(.done), .running, .queued])
    }

    func testOurOwnQueuedPressStaysOneRowThroughQueueAndStart() {
        var t = Log.timeline([Log.start(1, "t1", "first")])
        t.send(nonce: "n", text: "second", at: Log.at(10))
        let key = t.turns[1].id
        t.apply(Log.queued(2, "q1", "second", nonce: "n"))
        XCTAssertEqual(t.turns[1].state, .queued)
        t.apply(Log.end(3, "t1"))
        t.apply(Log.start(4, "t4", "second", nonce: "n", queued: "q1"))
        XCTAssertEqual(t.turns.count, 2)
        XCTAssertEqual(t.turns[1].id, key)
        XCTAssertEqual(t.turns[1].state, .running)
        XCTAssertTrue(t.queued.isEmpty)
    }

    func testTwoQueuedPressesStayTwoRowsInOrder() {
        var t = Log.timeline([Log.start(1, "t1", "first")])
        t.send(nonce: "a", text: "one", at: Log.at(10))
        t.send(nonce: "b", text: "two", at: Log.at(11))
        t.apply(Log.queued(2, "q1", "one", nonce: "a"))
        t.apply(Log.queued(3, "q2", "two", nonce: "b"))
        t.apply(Log.end(4, "t1"))
        t.apply(Log.start(5, "t5", "one", nonce: "a", queued: "q1"))
        t.apply(Log.end(6, "t5"))
        t.apply(Log.start(7, "t7", "two", nonce: "b", queued: "q2"))
        XCTAssertEqual(t.turns.map(\.prompt), ["first", "one", "two"])
        XCTAssertFalse(t.turns.contains { $0.state == .sending || $0.state == .queued })
    }

    func testASteerCarryingOurNonceRemovesTheOptimisticRow() {
        var t = Log.timeline([Log.start(1, "t1", "first")])
        t.send(nonce: "s", text: "also this", at: Log.at(10))
        t.apply(Log.step(2, "t1", "steer-2", .steer, "also this", .done, detail: ["clientNonce": .string("s")]))
        XCTAssertEqual(t.turns.count, 1)
        XCTAssertEqual(t.turns[0].steps.count, 1)
    }

    func testAStaleOptimisticRowMergesWithTheSameWordsWhenTheNonceIsLost() {
        var t = Log.timeline([Log.start(1, "t1", "first")])
        t.send(nonce: "lost", text: "second", at: Log.at(-60))
        t.apply(Log.queued(2, "q1", "second", nonce: "other"))
        XCTAssertEqual(t.turns.count, 2)
        XCTAssertEqual(t.turns[1].state, .queued)
        t.apply(Log.end(3, "t1"))
        t.apply(Log.start(4, "t4", "second", queued: "q1"))
        XCTAssertEqual(t.turns.count, 2)
        XCTAssertEqual(t.turns[1].state, .running)
    }

    func testAuthorsAreSetOnceAndLabelsDoNotFlicker() {
        var t = Log.timeline([Log.start(1, "t1", "mine"), Log.end(2, "t1"), Log.start(3, "t3", "theirs", author: Log.aarav)])
        let authors = t.turns.map(\.author)
        // More events, copies and an unrelated step with another author attached: nobody's label changes.
        t.apply(TimelineEvent(seq: 4, at: Log.at(4), body: .step(TimelineStepEvent(
            turnId: "t3", stepId: "steer-4", kind: .steer, label: "also this", status: .done, author: TimelineAuthor(id: "m9", name: "Zed")))))
        t.apply(Log.start(3, "t3", "theirs", author: TimelineAuthor(id: "m9", name: "Zed")))
        XCTAssertEqual(t.turns.map(\.author), authors)
        XCTAssertEqual(TimelineLabels.author(t.turns[0].author, me: nil), nil, "your own prompts carry no label")
        XCTAssertEqual(TimelineLabels.author(t.turns[1].author, me: "m1"), "Aarav")
        XCTAssertNil(TimelineLabels.author(t.turns[1].author, me: "m2"), "on Aarav's own Mac his prompts are 'you'")
    }

    func testReplicaOfAGuestSeesTheOwnersTimelineWithTheOwnersName() {
        // Over a pond the owner's own prompts carry the owner's name; the guest's own are theirs.
        let owner = TimelineAuthor(id: "m1", name: "Sibhi")
        let events = [
            Log.start(1, "t1", "owner prompt", author: owner), Log.end(2, "t1"),
            Log.start(3, "t3", "guest prompt", author: Log.aarav), Log.step(4, "t3", "x"), Log.end(5, "t3"),
        ]
        let truth = Log.timeline(events)
        for seed in 1...50 {
            var rng = SplitMix(state: UInt64(seed))
            var t = Log.timeline([events[0]])
            for e in (events + events.filter { _ in Bool.random(using: &rng) }).shuffled(using: &rng) { t.apply(e) }
            XCTAssertEqual(t, truth)
        }
        XCTAssertEqual(TimelineLabels.author(truth.turns[0].author, me: "m2"), "Sibhi")
        XCTAssertNil(TimelineLabels.author(truth.turns[1].author, me: "m2"))
    }

    func testOlderPagesGoAboveWithoutMovingWhatIsHeld() {
        let log = Log.busyChat()
        var t = TurnTimeline()
        t.load(Array(log.suffix(from: 14)), hasEarlier: true) // t14 onward
        XCTAssertTrue(t.hasEarlier)
        let held = t.turns
        t.prepend(Array(log.prefix(14)), hasEarlier: false)
        XCTAssertFalse(t.hasEarlier)
        XCTAssertEqual(Array(t.turns.suffix(held.count)), held)
        XCTAssertEqual(t.turns.map(\.turnId), ["t1", "t14", "t21"])
        // The same page again adds nothing.
        let once = t
        t.prepend(Array(log.prefix(14)), hasEarlier: false)
        XCTAssertEqual(t, once)
    }

    func testAnIdenticalRefreshIsZeroChange() {
        let log = Log.busyChat()
        var t = Log.timeline(log)
        let before = t
        t.load(log)
        t.load(Array(log.suffix(5)))
        for e in log { XCTAssertEqual(t.apply(e), .duplicate) }
        XCTAssertEqual(t, before)
        XCTAssertEqual(t.chatMessages, before.chatMessages)
    }

    func testReplyDeltasAreOffsetAddressed() {
        var t = Log.timeline([Log.start(1, "t1", "hi")])
        t.apply(ReplyDelta(turnId: "t1", blockKey: "m:0", offset: 0, text: "Hel"))
        t.apply(ReplyDelta(turnId: "t1", blockKey: "m:0", offset: 0, text: "Hel")) // a copy
        t.apply(ReplyDelta(turnId: "t1", blockKey: "m:0", offset: 3, text: "lo"))
        t.apply(ReplyDelta(turnId: "t1", blockKey: "m:0", offset: 2, text: "llo, wor")) // overlaps what is there
        XCTAssertEqual(t.turns[0].streaming?.text, "Hello, wor")
        t.apply(ReplyDelta(turnId: "t1", blockKey: "m:0", offset: 40, text: "x")) // skips ahead: waits for the message
        XCTAssertEqual(t.turns[0].streaming?.text, "Hello, wor")
        t.apply(ReplyDelta(turnId: "other", blockKey: "m:0", offset: 0, text: "no"))
        t.apply(Log.reply(2, "t1", "native-2", "Hello, world"))
        XCTAssertNil(t.turns[0].streaming)
        t.apply(Log.end(3, "t1", reply: "native-2"))
        t.apply(ReplyDelta(turnId: "t1", blockKey: "m:1", offset: 0, text: "late"))
        XCTAssertNil(t.turns[0].streaming)
        XCTAssertEqual(t.turns[0].reply?.label, "Hello, world")
    }

    func testStatusLineChangesTextInPlaceAndNeverAddsRows() {
        var t = Log.timeline([Log.start(1, "t1", "big")])
        let since = Log.t0.timeIntervalSince1970 * 1000
        t.apply(Log.step(2, "t1", "wait-1", .waiting, "Waiting for Claude", .running, detail: ["since": .number(since)]))
        let turn = t.turns[0]
        XCTAssertEqual(turn.statusLine(now: Log.t0.addingTimeInterval(20)), "Waiting for Claude")
        XCTAssertEqual(turn.statusLine(now: Log.t0.addingTimeInterval(4 * 60 + 5)), "Waiting for Claude · 4m")
        XCTAssertEqual(t.turns.count, 1)
        XCTAssertTrue(turn.listedSteps.isEmpty, "a wait is the status row, never a step row")
        t.apply(Log.step(3, "t1", "wait-1", .retrying, "Retrying Claude (2)", .running, detail: ["since": .number(since)]))
        XCTAssertEqual(t.turns[0].statusLine(now: Log.t0.addingTimeInterval(130)), "Retrying Claude (2) · 2m")
        t.apply(Log.step(4, "t1", "wait-1", .waiting, "Waiting for Claude", .done))
        t.apply(Log.step(5, "t1", "tu1", .tool, "Run npm test", .running))
        XCTAssertEqual(t.turns[0].statusLine(now: Log.t0.addingTimeInterval(10)), "Run npm test")
    }

    func testFoldedTitleNamesTheWork() {
        let t = Log.timeline(Log.busyChat())
        XCTAssertEqual(t.turns[0].foldedTitle, "Worked for 13s · 3 steps")
        XCTAssertNil(Log.timeline([Log.start(1, "t1", "x"), Log.end(2, "t1")]).turns[0].foldedTitle)
    }

    func testMessagesCarryTheTranscriptsIds() {
        let t = Log.timeline(Log.busyChat())
        let m = t.chatMessages
        XCTAssertEqual(m.first?.id, "native-1")
        XCTAssertEqual(m.first?.turnId, "t1")
        XCTAssertEqual(m.filter { $0.role == .assistant }.map(\.id), ["native-8", "native-13"])
        XCTAssertEqual(m.first { $0.id == "native-14" }?.authorName, "Aarav")
    }

    func testAFailedSendStaysAsARowUntilDiscarded() {
        var t = Log.timeline([Log.start(1, "t1", "a"), Log.end(2, "t1")])
        t.send(nonce: "n", text: "lost words")
        t.markNotSent(nonce: "n", reason: "Squeak is not running")
        XCTAssertEqual(t.turns.count, 2)
        XCTAssertEqual(t.turns[1].state, .notSent("Squeak is not running"))
        XCTAssertEqual(t.chatMessages.last?.state, .notSent(reason: "Squeak is not running"))
        t.discard(nonce: "n")
        XCTAssertEqual(t.turns.count, 1)
    }

    func testAnAgentStartedTurnHasNoPromptRow() {
        var t = TurnTimeline()
        t.load([TimelineEvent(seq: 1, at: Log.at(1), body: .turnStarted(
            turnId: "a5", promptMessageId: "auto-5", clientNonce: nil, text: "", author: nil, queuedId: nil, auto: true))])
        t.apply(Log.reply(2, "a5", "native-6", "worker one is back"))
        XCTAssertEqual(t.chatMessages.map(\.role), [.assistant])
    }

    // MARK: Decoding

    func testDecodesTheHostsEventsAndConsumesUnknownOnes() throws {
        let json = """
        {"events":[
          {"type":"turn.started","seq":1,"turnId":"t1","promptMessageId":"native-1","text":"hi","clientNonce":"n","author":{"id":"m2","name":"Aarav","initial":"A"},"at":"2026-11-14T10:00:00.000Z"},
          {"type":"step.added","seq":2,"turnId":"t1","stepId":"tu1","kind":"tool","label":"Run ls","status":"running","at":"2026-11-14T10:00:01.000Z"},
          {"type":"from.the.future","seq":3,"at":"2026-11-14T10:00:02.000Z"},
          {"type":"step.updated","seq":4,"turnId":"t1","stepId":"tu1","kind":"tool","label":"Run ls","status":"done","detail":{"x":1},"at":"2026-11-14T10:00:03.000Z"},
          {"nonsense":true},
          {"type":"turn.ended","seq":5,"turnId":"t1","outcome":"stopped","at":"2026-11-14T10:00:04.000Z"}
        ],"lastSeq":5,"hasEarlier":true}
        """
        let page = try JSONDecoder().decode(TimelinePage.self, from: Data(json.utf8))
        XCTAssertEqual(page.events.map(\.seq), [1, 2, 3, 4, 5])
        XCTAssertTrue(page.hasEarlier)
        XCTAssertEqual(page.events[0].body, .turnStarted(
            turnId: "t1", promptMessageId: "native-1", clientNonce: "n", text: "hi", author: TimelineAuthor(id: "m2", name: "Aarav", initial: "A"),
            queuedId: nil, auto: false))
        var t = TurnTimeline()
        t.load(page.events, hasEarlier: page.hasEarlier)
        XCTAssertNil(t.gapSince, "an event of a type this Mac does not know still takes its place in the order")
        XCTAssertEqual(t.turns[0].state, .ended(.stopped))
    }

    func testTheStreamsTimelineFramesBecomeEvents() {
        let step = #"{"type":"step.added","seq":4,"turnId":"t1","stepId":"a","kind":"tool","label":"Run ls","status":"running","at":"2026-11-14T10:00:00.000Z"}"#
        guard case .timeline(let e)? = NativeEvent.from(SSEFrame(event: "timeline", data: step, id: "4")) else { return XCTFail("a stored event") }
        XCTAssertEqual(e.seq, 4)
        let delta = #"{"type":"reply.delta","turnId":"t1","blockKey":"m:0","offset":0,"text":"hi"}"#
        XCTAssertEqual(NativeEvent.from(SSEFrame(event: "timeline", data: delta, id: nil)), .replyDelta(ReplyDelta(turnId: "t1", blockKey: "m:0", offset: 0, text: "hi")))
        XCTAssertNil(NativeEvent.from(SSEFrame(event: "timeline", data: "not json", id: nil)))
    }

    func testDecodesAReplyDeltaFrame() {
        let d = TimelineEvent.replyDelta(from: Data(#"{"type":"reply.delta","turnId":"t1","blockKey":"m:0","offset":3,"text":"lo"}"#.utf8))
        XCTAssertEqual(d, ReplyDelta(turnId: "t1", blockKey: "m:0", offset: 3, text: "lo"))
        XCTAssertNil(TimelineEvent.replyDelta(from: Data(#"{"type":"turn.ended","seq":1}"#.utf8)))
    }
}
