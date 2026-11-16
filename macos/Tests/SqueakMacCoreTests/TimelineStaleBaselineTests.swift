import XCTest
@testable import SqueakMacCore

/// Live shape (a long chat): the newest page starts far past a baseline held with no turns; it must show, not wait behind a gap.
final class TimelineStaleBaselineTests: XCTestCase {
    private func page() -> [TimelineEvent] {
        [Log.start(2896, "t1", "a"), Log.reply(2897, "t1", "m1", "hello"), Log.end(2898, "t1"),
         Log.start(2899, "t2", "b"), Log.reply(2900, "t2", "m2", "world"), Log.end(2901, "t2")]
    }

    func testAnEmptyBaselineDoesNotHoldANewestPageBehindAGap() {
        var t = TurnTimeline()
        t.load([], hasEarlier: true)
        XCTAssertTrue(t.hasBaseline)
        t.load(page(), hasEarlier: true)
        XCTAssertEqual(t.turns.count, 2)
        XCTAssertEqual(t.lastSeq, 2901)
        XCTAssertTrue(t.hasEarlier)
        XCTAssertEqual(t.oldestSeq, 2896)
        XCTAssertFalse(TimelinePresentation(t, now: Log.t0).messages.isEmpty)
    }

    func testAnEarlierPageStillPrependsAfterTheRebase() {
        var t = TurnTimeline()
        t.load([], hasEarlier: true)
        t.load(page(), hasEarlier: true)
        t.prepend([Log.start(10, "t0", "z"), Log.reply(11, "t0", "m0", "old"), Log.end(12, "t0")], hasEarlier: false)
        XCTAssertEqual(t.turns.map(\.turnId), ["t0", "t1", "t2"])
        XCTAssertFalse(t.hasEarlier)
    }

    func testAHeldPageWithTurnsKeepsItsGapRule() {
        var t = TurnTimeline()
        t.load([Log.start(1, "t1", "a")])
        XCTAssertEqual(t.apply(Log.end(5, "t1")), .held(gapSince: 1))
    }
}
