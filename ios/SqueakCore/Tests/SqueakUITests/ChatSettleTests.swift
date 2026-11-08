import SqueakCore
import XCTest
@testable import SqueakUI

final class SettleStateTests: XCTestCase {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }

    func testNotSettledUntilHalfASecondAfterAppearing() {
        let s = SettleState(appearedAt: t0)
        XCTAssertFalse(s.isSettled(at: at(0)))
        XCTAssertFalse(s.isSettled(at: at(0.49)))
        XCTAssertTrue(s.isSettled(at: at(0.5)))
    }

    func testLayoutChangeRestartsTheWait() {
        var s = SettleState(appearedAt: t0)
        s.layoutChanged(at: at(0.4))
        XCTAssertFalse(s.isSettled(at: at(0.8)))
        XCTAssertTrue(s.isSettled(at: at(0.9)))
    }

    func testAnOlderLayoutChangeNeverShortensTheWait() {
        var s = SettleState(appearedAt: at(2))
        s.layoutChanged(at: at(1))
        XCTAssertEqual(s.settledAt, at(2.5))
    }

    func testNeverSettledWhileScrolling() {
        var s = SettleState(appearedAt: t0)
        s.scrollChanged(scrolling: true, at: at(1))
        XCTAssertNil(s.settledAt)
        XCTAssertFalse(s.isSettled(at: at(60)))
    }

    func testScrollEndWaitsItsOwnShorterSettle() {
        var s = SettleState(appearedAt: t0)
        s.scrollChanged(scrolling: true, at: at(1))
        s.scrollChanged(scrolling: false, at: at(5))
        XCTAssertFalse(s.isSettled(at: at(5.29)))
        XCTAssertTrue(s.isSettled(at: at(5.3)))
    }

    func testLayoutChangeDuringTheScrollStillCountsAfterIt() {
        var s = SettleState(appearedAt: t0)
        s.scrollChanged(scrolling: true, at: at(1))
        s.layoutChanged(at: at(5))
        s.scrollChanged(scrolling: false, at: at(5.1))
        XCTAssertFalse(s.isSettled(at: at(5.4)))
        XCTAssertTrue(s.isSettled(at: at(5.5)))
    }
}

final class UpdateCoalescerTests: XCTestCase {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    func testABurstSharesOneFlush() {
        var c = UpdateCoalescer()
        XCTAssertEqual(c.offer(at: t0), .schedule(t0.addingTimeInterval(0.15)))
        XCTAssertEqual(c.offer(at: t0.addingTimeInterval(0.05)), .pending(t0.addingTimeInterval(0.15)))
        XCTAssertEqual(c.offer(at: t0.addingTimeInterval(0.1)), .pending(t0.addingTimeInterval(0.15)))
        c.flushed()
        XCTAssertEqual(c.offer(at: t0.addingTimeInterval(1)), .schedule(t0.addingTimeInterval(1.15)))
    }

    func testUrgentFlushesAtOnceAndClearsTheWait() {
        var c = UpdateCoalescer()
        _ = c.offer(at: t0)
        XCTAssertEqual(c.offer(at: t0.addingTimeInterval(0.01), urgent: true), .now)
        XCTAssertNil(c.deadline)
    }
}

@MainActor
final class ChatTimelineStoreTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    func session(_ message: String, state: String = "idle", turn: String = "t1") -> PhoneSnapshot.Session {
        PhoneSnapshot.Session(
            key: "k", conductorSessionId: "c1", label: "repo · branch", agent: "claude", state: state,
            lastActivityAt: "2026-11-08T10:00:00.000Z", detail: nil, git: nil, contextPercent: nil, turnId: turn, message: message,
            choices: nil, activity: nil)
    }
    func input(_ message: String, sends: [ChatSend] = [], history: [LiveTurn.HistoryEntry]? = nil) -> TimelineInput {
        TimelineInput(session: session(message), remembered: nil, sends: sends, live: nil, cachedHistory: history)
    }
    func store() -> ChatTimelineStore {
        let n = now
        return ChatTimelineStore(sleep: { _ in await Task.yield() }, clock: { n })
    }
    let history = [LiveTurn.HistoryEntry(role: "user", text: "hello", at: "2026-11-08T09:00:00.000Z")]

    func testPlaceholderUntilHistoryThenOneSwap() async {
        let s = store()
        s.submit(input("A"))
        XCTAssertNil(s.frame)
        s.submit(input("A", history: history))
        XCTAssertNotNil(s.frame)
        XCTAssertEqual(s.swaps, 1)
    }

    func testPlaceholderGivesWayAfterItsLimit() async {
        let s = store()
        s.submit(input("A"))
        await s.settle()
        XCTAssertNotNil(s.frame)
    }

    func testSeedShowsAtOnceAndIsReplacedInOneSwapWhenDataDiffers() async {
        let seed = input("old", history: history).build(now: now)
        let s = store()
        s.submit(input("new", history: history), seed: seed)
        XCTAssertEqual(s.frame, seed)
        await s.settle()
        XCTAssertEqual(s.frame?.session.message, "new")
        XCTAssertEqual(s.swaps, 2)
    }

    func testABurstOfInputsIsOneSwap() async {
        let s = store()
        s.submit(input("A", history: history))
        let base = s.swaps
        s.submit(input("B", history: history))
        s.submit(input("C", history: history))
        s.submit(input("D", history: history))
        XCTAssertEqual(s.swaps, base)
        await s.settle()
        XCTAssertEqual(s.swaps, base + 1)
        XCTAssertEqual(s.frame?.session.message, "D")
    }

    func testOwnSendAppliesAtOnce() {
        let s = store()
        s.submit(input("A", history: history))
        let send = ChatSend(text: "go", date: now, answersTurn: "t1", status: .sending)
        s.submit(input("A", sends: [send], history: history))
        XCTAssertTrue(s.frame?.rows.contains { if case .sent = $0 { true } else { false } } ?? false)
    }

    func testEqualInputChangesNothing() {
        let s = store()
        s.submit(input("A", history: history))
        let swaps = s.swaps
        s.submit(input("A", history: history))
        XCTAssertEqual(s.swaps, swaps)
    }

    func testFrameCacheKeepsTheNewestTwelve() {
        var cache = TimelineFrameCache()
        let frame = input("A").build(now: now)
        for i in 0..<15 { cache.keep(frame, for: "k\(i)") }
        XCTAssertNil(cache.frame(for: "k0"))
        XCTAssertNil(cache.frame(for: "k2"))
        XCTAssertNotNil(cache.frame(for: "k3"))
        XCTAssertNotNil(cache.frame(for: "k14"))
    }
}
