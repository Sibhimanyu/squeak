import XCTest
@testable import SqueakMacCore

/// What the screens read from the timeline, and what a refresh changes in it.
final class TimelinePresentationTests: XCTestCase {
    private let now = Log.t0.addingTimeInterval(500)

    func testARefreshWithIdenticalDataChangesNothing() {
        let log = Log.busyChat()
        var t = Log.timeline(log)
        let before = TimelinePresentation(t, now: now)
        // The host's first page read again, the stream's replay of everything, a reconnect's since-read: all copies.
        t.load(log)
        t.load(Array(log.suffix(6)))
        for e in log { t.apply(e) }
        let after = TimelinePresentation(t, now: now)
        XCTAssertEqual(after, before)
        XCTAssertTrue(after.changedRows(from: before).isEmpty, "zero diffs: no row is redrawn")
        XCTAssertEqual(after.rowIds, before.rowIds)
    }

    func testANewEventChangesOnlyTheTurnItBelongsTo() {
        var t = Log.timeline(Array(Log.busyChat().prefix(22)))
        let before = TimelinePresentation(t, now: now)
        XCTAssertEqual(t.turns.last?.state, .running)
        t.apply(Log.step(23, "t21", "tu5", .tool, "Run date", .running))
        let after = TimelinePresentation(t, now: now)
        XCTAssertEqual(after.changedRows(from: before), [t.turns.last!.id])
        // The earlier turns' drawing is byte-for-byte the same.
        for id in before.rowIds.dropLast() { XCTAssertEqual(after.segments[id], before.segments[id]) }
    }

    func testAPressedRowReconcilesWithoutChangingItsKeyOrNeighbours() {
        var t = Log.timeline([Log.start(1, "t1", "a"), Log.end(2, "t1")])
        t.send(nonce: UUID().uuidString, text: "b", at: Log.at(30))
        let pressed = TimelinePresentation(t, now: now)
        let nonce = t.turns[1].clientNonce!
        t.apply(Log.start(3, "t3", "b", nonce: nonce))
        let named = TimelinePresentation(t, now: now)
        XCTAssertEqual(named.rowIds, pressed.rowIds)
        XCTAssertEqual(named.messages.map(\.text), ["a", "b"])
        XCTAssertEqual(named.messages[1].id, "native-3")
    }

    func testWorkRunsKeepTheirIdentityFromRunningToEnded() {
        var t = Log.timeline([Log.start(1, "t1", "go"), Log.step(2, "t1", "tu1", .tool, "Run ls", .running)])
        let running = TimelineSteps.segments(of: t.turns[0])
        XCTAssertEqual(running.map(\.id), ["work-tu1"])
        t.apply(Log.step(3, "t1", "tu1", .tool, "Run ls", .done))
        t.apply(Log.reply(4, "t1", "native-4", "done"))
        t.apply(Log.step(5, "t1", "tu2", .tool, "Run pwd", .running))
        t.apply(Log.reply(6, "t1", "native-6", "all done"))
        // Running: work, words, work, words in the order they happened.
        XCTAssertEqual(TimelineSteps.segments(of: t.turns[0]).map(\.id), ["work-tu1", "native-4", "work-tu2", "native-6"])
        t.apply(Log.end(7, "t1", reply: "native-6"))
        // Ended: the work folds into one run (under the first one's id), then the words.
        let ended = TimelineSteps.segments(of: t.turns[0])
        XCTAssertEqual(ended.map(\.id), ["work-tu1", "native-4", "native-6"])
        if case .work(_, let steps, let live) = ended[0] {
            XCTAssertEqual(steps.map(\.toolId), ["tu1", "tu2"])
            XCTAssertFalse(live)
        } else { XCTFail("the fold comes first") }
    }

    func testSteersSitInTheirPlaceAndCarryTheirAuthor() {
        var t = Log.timeline([Log.start(1, "t1", "go"), Log.step(2, "t1", "tu1", .tool, "Run ls", .running)])
        t.apply(TimelineEvent(seq: 3, at: Log.at(3), body: .step(TimelineStepEvent(
            turnId: "t1", stepId: "steer-3", kind: .steer, label: "also this", detail: ["text": .string("also this, please")],
            status: .done, author: Log.aarav))))
        t.apply(Log.step(4, "t1", "tu2", .tool, "Run pwd", .running))
        let segs = TimelineSteps.segments(of: t.turns[0])
        XCTAssertEqual(segs.map(\.id), ["work-tu1", "steer-3", "work-tu2"])
        if case .steer(_, let text, let author) = segs[1] {
            XCTAssertEqual(text, "also this, please")
            XCTAssertEqual(author, Log.aarav)
        } else { XCTFail("a steer") }
    }

    func testTheDockSeesTheWaitAsTheLastActivityStep() {
        var t = Log.timeline([Log.start(1, "t1", "go")])
        t.apply(Log.step(2, "t1", "wait-1", .waiting, "Waiting for Claude", .running, detail: ["since": .number(Log.t0.timeIntervalSince1970 * 1000)]))
        let p = TimelinePresentation(t, now: Log.t0.addingTimeInterval(5 * 60 + 2))
        XCTAssertEqual(NativeLiveState.waitingLine(p.activity), "Waiting for Claude · 5m")
        let later = TimelinePresentation(t, now: Log.t0.addingTimeInterval(6 * 60 + 2))
        XCTAssertEqual(NativeLiveState.waitingLine(later.activity), "Waiting for Claude · 6m")
        XCTAssertEqual(later.rowIds, p.rowIds, "only the text changes; no row is added")
        XCTAssertEqual(later.segments, p.segments)
    }

    func testAnEndedTurnFoldsToItsTitleAndAReplyOutsideIt() {
        let t = Log.timeline(Log.busyChat())
        let p = TimelinePresentation(t, now: now)
        let first = p.segments["t1"]!
        XCTAssertEqual(first.map(\.id), ["work-m1:0", "native-8", "native-13"], "one fold, then the agent's words; the reply is the last")
        XCTAssertEqual(t.turns[0].reply?.id, "native-13")
        XCTAssertEqual(p.turnWork["t1"]?.map(\.kind), ["you", "thinking", "tool", "note", "tool", "note"])
    }

    func testPagingSaysWhetherThereIsMoreAbove() {
        let log = Log.busyChat()
        var t = TurnTimeline()
        t.load(Array(log.suffix(from: 14)), hasEarlier: true)
        XCTAssertTrue(TimelinePresentation(t, now: now, olderLoading: true).paging.loading)
        XCTAssertTrue(TimelinePresentation(t, now: now).paging.canLoad)
        t.prepend(Array(log.prefix(14)), hasEarlier: false)
        XCTAssertTrue(TimelinePresentation(t, now: now).paging.reachedStart)
    }
}
