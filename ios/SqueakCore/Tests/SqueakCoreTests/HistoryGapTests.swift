import XCTest
@testable import SqueakCore

/// A phone away while more than the live push carries happened holds a history with a hole in it.
final class HistoryGapTests: XCTestCase {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    func iso(_ n: Int) -> String {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: t0.addingTimeInterval(Double(n) * 60))
    }
    /// Message `n` of the chat: ids and times rise together, users on even numbers.
    func m(_ n: Int) -> LiveTurn.HistoryEntry {
        .init(role: n % 2 == 0 ? "user" : "assistant", text: "m\(n)", at: iso(n), id: "\(n)")
    }
    func run(_ r: ClosedRange<Int>) -> [LiveTurn.HistoryEntry] { r.map(m) }
    func page(_ r: ClosedRange<Int>, before: Int, complete: Bool = false) -> HistoryPage {
        HistoryPage(key: "k", before: "\(before)", entries: run(r), nextBefore: complete ? nil : "\(r.lowerBound)", complete: complete)
    }

    func testAPushThatOverlapsWhatWasHeldLeavesNoGap() {
        var state = ChatHistoryState(entries: run(1...8))
        state.mergeLatest(run(5...12))
        XCTAssertNil(state.gap)
        XCTAssertEqual(state.entries.map(\.id), (1...12).map { "\($0)" })
    }

    func testAPushThatDoesNotReachBackLeavesAGapAtItsEdge() {
        var state = ChatHistoryState(entries: run(1...8))
        state.mergeLatest(run(21...28))
        XCTAssertEqual(state.gap, ChatHistoryState.Gap(above: "21", before: "21"))
        XCTAssertEqual(state.entries.count, 16)
    }

    func testAPushThatFollowsOnWithoutAHoleClosesAfterOnePage() {
        // No overlap, yet nothing missing in between: the first page closes it without adding anything.
        var state = ChatHistoryState(entries: run(1...8))
        state.mergeLatest(run(9...16))
        XCTAssertNotNil(state.gap)
        XCTAssertTrue(state.fill(page(1...8, before: 9)))
        XCTAssertNil(state.gap)
        XCTAssertEqual(state.entries.map(\.id), (1...16).map { "\($0)" })
    }

    func testPagesWalkBackUntilTheyJoinWhatWasHeld() {
        var state = ChatHistoryState(entries: run(1...8))
        state.mergeLatest(run(33...40))
        XCTAssertFalse(state.fill(page(21...32, before: 33)))
        XCTAssertEqual(state.gap, ChatHistoryState.Gap(above: "21", before: "21"))
        XCTAssertFalse(state.fill(page(9...20, before: 21)))
        XCTAssertEqual(state.gap?.above, "9")
        // The last page reaches message 8, which is held: joined.
        XCTAssertTrue(state.fill(page(5...8, before: 9)))
        XCTAssertNil(state.gap)
        XCTAssertEqual(state.entries.map(\.id), (1...40).map { "\($0)" })
    }

    func testAPageOverlappingByTimeAloneJoinsToo() {
        var state = ChatHistoryState(entries: run(1...8))
        state.mergeLatest(run(13...20))
        // The Mac's page does not repeat 8 but starts before its time (ids differ, e.g. a clipped message).
        let early = HistoryPage(key: "k", before: "13", entries: [.init(role: "user", text: "x", at: iso(7), id: "70")] + run(9...12),
                                nextBefore: "70", complete: false)
        XCTAssertTrue(state.fill(early))
        XCTAssertNil(state.gap)
        // The entry older than the last one held is not inserted again.
        XCTAssertFalse(state.entries.contains { $0.id == "70" })
        XCTAssertEqual(state.entries.map(\.id), (1...20).map { "\($0)" })
    }

    func testReachingTheStartOfTheChatClosesTheGap() {
        var state = ChatHistoryState(entries: [m(30)])
        state.mergeLatest(run(40...47))
        XCTAssertTrue(state.fill(page(31...39, before: 40, complete: true)))
        XCTAssertNil(state.gap)
    }

    func testAnEmptyPageClosesTheGapSoItIsNotAskedForever() {
        var state = ChatHistoryState(entries: run(1...8))
        state.mergeLatest(run(21...28))
        XCTAssertTrue(state.fill(HistoryPage(key: "k", before: "21", entries: [], nextBefore: nil, complete: false)))
        XCTAssertNil(state.gap)
    }

    func testAnEntryWithoutAnIdCannotBePagedFromSoThereIsNoGap() {
        var state = ChatHistoryState(entries: [.init(role: "user", text: "old", at: iso(1))])
        state.mergeLatest([.init(role: "user", text: "new", at: iso(50))])
        XCTAssertNil(state.gap)
    }

    func testALaterPushThatReachesBackClosesTheGap() {
        var state = ChatHistoryState(entries: run(1...8))
        state.mergeLatest(run(21...28))
        XCTAssertNotNil(state.gap)
        // Pages were not needed after all: the Mac's window slid back over what was held (an edit rewrote ids).
        state.mergeLatest(run(5...12))
        XCTAssertNil(state.gap)
    }

    func testALaterPushInsideTheNewerPartKeepsTheGap() {
        var state = ChatHistoryState(entries: run(1...8))
        state.mergeLatest(run(21...28))
        state.mergeLatest(run(25...32))
        XCTAssertEqual(state.gap, ChatHistoryState.Gap(above: "21", before: "21"))
        XCTAssertEqual(state.entries.map(\.id), (1...8).map { "\($0)" } + (21...32).map { "\($0)" })
    }

    func testASecondHoleDropsWhatLayBelowTheFirst() {
        var state = ChatHistoryState(entries: run(1...8), nextBefore: nil, complete: true)
        state.mergeLatest(run(21...28))
        state.mergeLatest(run(41...48))
        XCTAssertEqual(state.gap, ChatHistoryState.Gap(above: "41", before: "41"))
        // Only the newer run and what leads to it remain; the old tail below the first hole is gone and loadable again.
        XCTAssertEqual(state.entries.first?.id, "21")
        XCTAssertFalse(state.complete)
        XCTAssertNil(state.nextBefore)
        XCTAssertEqual(state.cursor, "21")
    }

    func testTrimmingAwayEverythingBelowTheHoleDropsIt() {
        var state = ChatHistoryState(entries: run(1...8))
        state.mergeLatest(run(21...28))
        state.trimTo(8)
        XCTAssertNil(state.gap)
    }

    func testAStateSavedBeforeGapsExistStillDecodes() throws {
        let json = #"{"entries":[{"role":"user","text":"x","id":"1"}],"nextBefore":null,"complete":false}"#
        let state = try JSONDecoder().decode(ChatHistoryState.self, from: Data(json.utf8))
        XCTAssertNil(state.gap)
    }
}
