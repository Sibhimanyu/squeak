import SqueakCore
import XCTest
@testable import SqueakUI

final class EarlierPagingTests: XCTestCase {
    func entry(_ i: Int, id: Bool = true) -> LiveTurn.HistoryEntry {
        .init(role: i % 2 == 0 ? "user" : "assistant", text: "m\(i)", at: "2026-10-24T10:\(String(format: "%02d", i % 60)):00.000Z", id: id ? "\(i * 10)" : nil)
    }
    let conductor = PhoneSnapshot.Session(
        key: "k", conductorSessionId: "c1", label: "l", agent: "claude", state: "finished", lastActivityAt: "2026-10-24T10:00:00.000Z",
        detail: nil, git: nil, contextPercent: nil, turnId: "t", message: "m", choices: nil)

    func testRowDecisions() {
        let held = ChatHistoryState(entries: [entry(1)])
        XCTAssertEqual(EarlierPaging.row(available: true, state: held, load: .idle), .sentinel)
        XCTAssertEqual(EarlierPaging.row(available: true, state: held, load: .loading), .loading)
        XCTAssertEqual(EarlierPaging.row(available: true, state: held, load: .failed), .failed)
        var done = held; done.complete = true
        XCTAssertEqual(EarlierPaging.row(available: true, state: done, load: .idle), .start)
        // A terminal agent, or a chat with nothing held, has nothing to load above it.
        XCTAssertEqual(EarlierPaging.row(available: false, state: held, load: .idle), .none)
        XCTAssertEqual(EarlierPaging.row(available: true, state: nil, load: .idle), .none)
        XCTAssertEqual(EarlierPaging.row(available: true, state: ChatHistoryState(), load: .idle), .none)
    }

    func testFetchRules() {
        let held = ChatHistoryState(entries: [entry(1)])
        XCTAssertTrue(EarlierPaging.shouldFetch(available: true, state: held, load: .idle, manual: false))
        XCTAssertFalse(EarlierPaging.shouldFetch(available: true, state: held, load: .loading, manual: true), "one in flight per chat")
        XCTAssertFalse(EarlierPaging.shouldFetch(available: true, state: held, load: .failed, manual: false), "the sentinel does not hammer a bad link")
        XCTAssertTrue(EarlierPaging.shouldFetch(available: true, state: held, load: .failed, manual: true))
        var done = held; done.complete = true
        XCTAssertFalse(EarlierPaging.shouldFetch(available: true, state: done, load: .idle, manual: true))
        XCTAssertFalse(EarlierPaging.shouldFetch(available: false, state: held, load: .idle, manual: true))
    }

    func testAvailability() {
        XCTAssertTrue(EarlierPaging.available(session: conductor, streamed: true, demo: false))
        XCTAssertFalse(EarlierPaging.available(session: conductor, streamed: false, demo: false), "Firestore cannot carry the page")
        XCTAssertFalse(EarlierPaging.available(session: conductor, streamed: true, demo: true))
        var terminal = conductor
        terminal = PhoneSnapshot.Session(key: "t", conductorSessionId: nil, label: "l", agent: "claude", state: "finished",
                                         lastActivityAt: "2026-10-24T10:00:00.000Z", detail: nil, git: nil, contextPercent: nil,
                                         turnId: nil, message: nil, choices: nil)
        XCTAssertFalse(EarlierPaging.available(session: terminal, streamed: true, demo: false))
    }

    func testAPageForAnotherCursorOrChatIsIgnored() {
        let page = HistoryPage(key: "k", before: "40", entries: [], nextBefore: nil, complete: true)
        XCTAssertTrue(EarlierPaging.matches(page, key: "k", before: "40"))
        XCTAssertFalse(EarlierPaging.matches(page, key: "k", before: nil))
        XCTAssertFalse(EarlierPaging.matches(page, key: "other", before: "40"))
    }

    func testAnchorKeepsTheOldFirstRowOnlyWhenOlderOnesLandAndTheReaderIsAway() {
        let ids = ["h-a", "h-b", "h-c"]
        XCTAssertEqual(PrependAnchor.target(oldTop: "h-b", newTop: "h-a", ids: ids, prepended: true, following: false), "h-b")
        XCTAssertNil(PrependAnchor.target(oldTop: "h-b", newTop: "h-a", ids: ids, prepended: true, following: true))
        XCTAssertNil(PrependAnchor.target(oldTop: "h-b", newTop: "h-a", ids: ids, prepended: false, following: false), "a sliding window is not a prepend")
        XCTAssertNil(PrependAnchor.target(oldTop: "h-b", newTop: "h-b", ids: ids, prepended: true, following: false))
        XCTAssertNil(PrependAnchor.target(oldTop: "gone", newTop: "h-a", ids: ids, prepended: true, following: false))
        XCTAssertNil(PrependAnchor.target(oldTop: nil, newTop: "h-a", ids: ids, prepended: true, following: false))
        XCTAssertEqual(PrependAnchor.topID([.empty("x")]), nil)
        XCTAssertEqual(PrependAnchor.topID([.worked(id: "w", steps: 1)]), "w")
    }

    /* ---------- merging ---------- */

    func testLivePushMergesOverTheTailAndKeepsOlderPages() {
        var state = ChatHistoryState(entries: (1...8).map { entry($0) })
        state.prepend(HistoryPage(key: "k", before: "10", entries: (-3...0).map { entry($0) }, nextBefore: "-30", complete: false))
        XCTAssertEqual(state.entries.map(\.text), ["m-3", "m-2", "m-1", "m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"])
        // The newest eight slide by two: the older pages and the overlap stay once.
        state.mergeLatest((3...10).map { entry($0) })
        XCTAssertEqual(state.entries.map(\.text), ["m-3", "m-2", "m-1", "m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"])
        XCTAssertEqual(state.nextBefore, "-30")
        XCTAssertFalse(state.complete)
    }

    func testLivePushWithNoOverlapKeepsOnlyWhatIsOlder() {
        var state = ChatHistoryState(entries: (1...4).map { entry($0) })
        state.mergeLatest((20...27).map { entry($0) })
        XCTAssertEqual(state.entries.map(\.text), ["m1", "m2", "m3", "m4"] + (20...27).map { "m\($0)" })
    }

    func testMergeDedupesByIdElseByRoleTimeAndText() {
        var state = ChatHistoryState(entries: [entry(1, id: false), entry(2, id: false)])
        state.mergeLatest([entry(2, id: true), entry(3, id: true)])
        XCTAssertEqual(state.entries.map(\.text), ["m1", "m2", "m3"], "an entry the older Mac sent without an id still matches")
        let page = HistoryPage(key: "k", before: nil, entries: [entry(0), entry(1)], nextBefore: nil, complete: true)
        state.prepend(page)
        XCTAssertEqual(state.entries.map(\.text), ["m0", "m1", "m2", "m3"])
        XCTAssertTrue(state.complete)
        XCTAssertEqual(state.cursor, nil)
    }

    func testCursorIsTheMacsOrTheOldestEntrysId() {
        var state = ChatHistoryState(entries: [entry(3), entry(4)])
        XCTAssertEqual(state.cursor, "30")
        state.nextBefore = "7"
        XCTAssertEqual(state.cursor, "7")
        XCTAssertNil(ChatHistoryState(entries: [entry(3, id: false)]).cursor)
    }

    func testTrimMovesTheCursorToTheOldestKept() {
        var state = ChatHistoryState(entries: (1...10).map { entry($0) }, nextBefore: nil, complete: true)
        state.trimTo(4)
        XCTAssertEqual(state.entries.map(\.text), ["m7", "m8", "m9", "m10"])
        XCTAssertEqual(state.nextBefore, "70")
        XCTAssertFalse(state.complete)
    }

    func testOverlayPutsALivePushOverHeldPagesWithoutKeepingEither() {
        let held = (1...6).map { entry($0) }
        XCTAssertEqual(ChatHistoryState.overlay(held, nil), held)
        XCTAssertEqual(ChatHistoryState.overlay(held, []), held)
        XCTAssertEqual(ChatHistoryState.overlay(nil, [entry(1)]), [entry(1)])
        XCTAssertEqual(ChatHistoryState.overlay(held, [entry(5), entry(6), entry(7)])?.map(\.text), ["m1", "m2", "m3", "m4", "m5", "m6", "m7"])
    }

    func testTimelineShowsOlderPagesBeneathTheLivePush() {
        // The chat shows what was paged in even while the live turn carries only its newest entries.
        let held = [entry(0), entry(1), entry(2), entry(3)]
        var live = LiveTurn(key: "k", working: false, total: 0, steps: [], history: [entry(2), entry(3)])
        live.history = [entry(2), entry(3)]
        let rows = ChatTimeline.rows(session: conductor, remembered: nil, sends: [], live: live, cachedHistory: held)
        let texts = rows.compactMap { row -> String? in if case .history(_, _, let t, _) = row { t } else { nil } }
        XCTAssertEqual(texts, ["m0", "m1", "m2", "m3"])
    }
}
