import XCTest
@testable import SqueakMacCore

final class ActivityFeedMergeTests: XCTestCase {
    private func tool(_ id: String, _ text: String = "Run `x`") -> ActivityStep { ActivityStep(kind: "tool", text: text, at: Date(timeIntervalSince1970: 100), toolId: id) }
    private func think(_ t: Double, _ text: String = "Thought") -> ActivityStep { ActivityStep(kind: "thinking", text: text, at: Date(timeIntervalSince1970: t)) }
    private var full: [ActivityStep] { [think(1), tool("a"), think(2), tool("b"), think(3)] }

    func testEmptyFailedAndStaleReadsNeverShrink() {
        var m = ActivityFeedMerge()
        XCTAssertEqual(m.apply(incoming: full, live: nil, working: true, turn: "t1").steps.count, 5)
        for incoming in [[], nil, Array(full.prefix(2))] as [[ActivityStep]?] {
            let next = m.apply(incoming: incoming, live: nil, working: true, turn: "t1").steps
            XCTAssertEqual(next, full, "an input that says less removes nothing")
        }
        let grown = m.apply(incoming: full + [tool("c")], live: nil, working: true, turn: "t1").steps
        XCTAssertEqual(grown.map(\.toolId), [nil, "a", nil, "b", nil, "c"])
    }

    func testHeldRowsKeepTheirPlaceWhenARowIsMissing() {
        var m = ActivityFeedMerge()
        _ = m.apply(incoming: full, live: nil, working: true, turn: "t1")
        let partial = [full[0], full[2], full[3], full[4], tool("c")]
        let out = m.apply(incoming: partial, live: nil, working: true, turn: "t1").steps
        XCTAssertEqual(out.compactMap(\.toolId), ["a", "b", "c"])
        XCTAssertEqual(out.count, 6)
    }

    func testLiveToolIsHeldUntilItsRowLandsThenUpdatesInPlace() {
        var m = ActivityFeedMerge()
        _ = m.apply(incoming: full, live: nil, working: true, turn: "t1")
        let live = ActivityStep(kind: "tool", text: "Running a command", toolId: "c")
        XCTAssertEqual(m.apply(incoming: nil, live: live, working: true, turn: "t1").steps.count, 6)
        // The live step is cleared before its row is read: the row stays.
        XCTAssertEqual(m.apply(incoming: full, live: nil, working: true, turn: "t1").steps.last?.toolId, "c")
        let landed = m.apply(incoming: full + [tool("c", "Run `real`")], live: nil, working: true, turn: "t1").steps
        XCTAssertEqual(landed.count, 6)
        XCTAssertEqual(landed.last?.text, "Run `real`")
    }

    func testThinkingPlaceholderIsTransient() {
        var m = ActivityFeedMerge()
        let ph = ActivityStep(kind: "thinking", text: NativeLiveState.thinkingText)
        XCTAssertEqual(m.apply(incoming: [tool("a")], live: ph, working: true, turn: "t").steps.count, 2)
        XCTAssertEqual(m.apply(incoming: [tool("a")], live: nil, working: true, turn: "t").steps.count, 1)
    }

    func testProgressTrackerFollowsTheLatestRead() {
        var m = ActivityFeedMerge()
        _ = m.apply(incoming: [tool("a"), ActivityStep(kind: "progress", text: "1/3")], live: nil, working: true, turn: "t")
        let out = m.apply(incoming: [tool("a")], live: nil, working: true, turn: "t").steps
        XCTAssertFalse(out.contains { $0.kind == "progress" })
    }

    func testStateFlippingWhileHelpersRunKeepsRowsAndEndsOnce() {
        var m = ActivityFeedMerge()
        var ends = 0
        _ = m.apply(incoming: full, live: nil, working: true, turn: "t1")
        for working in [true, false, false, true] {
            let r = m.apply(incoming: [], live: nil, working: working, turn: "t1")
            XCTAssertEqual(r.steps, full)
            if r.turnEnded { ends += 1 }
        }
        XCTAssertEqual(ends, 1)
        // Finished: the host's record replaces the feed.
        XCTAssertEqual(m.apply(incoming: full + [tool("z")], live: nil, working: false, turn: "t1").steps.count, 6)
    }

    func testNewTurnStartsFresh() {
        var m = ActivityFeedMerge()
        _ = m.apply(incoming: full, live: nil, working: true, turn: "t1")
        XCTAssertEqual(m.apply(incoming: [], live: nil, working: true, turn: "t2").steps, [])
    }

    func testTurnItemIdsStayAsTheFeedGrowsAndASummaryFillsIn() {
        let a = TurnFolding.block(steps: [think(1, "Reading"), tool("a")], working: true)
        let b = TurnFolding.block(steps: [think(1, "Reading the file closely"), tool("a"), tool("b")], working: true)
        let before = (a.folded + a.shown).map(\.id)
        let after = (b.folded + b.shown).map(\.id)
        XCTAssertEqual(Array(after.prefix(before.count)), before)
    }
}
