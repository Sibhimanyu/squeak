import XCTest

@testable import SqueakMacCore

final class ChatScrollMemoryTests: XCTestCase {
    private func snap(following: Bool = false, top: Double = 800, first: String? = "m1", last: String? = "m9") -> ChatScrollMemory.Snapshot {
        .init(following: following, fromTop: top, firstRow: first, lastRow: last)
    }

    func testNoSnapshotOrFollowingOpensOnTheNewestEnd() {
        XCTAssertEqual(ChatScrollMemory.resolve(nil, firstRow: "m1", lastRow: "m9"), .follow)
        XCTAssertEqual(ChatScrollMemory.resolve(snap(following: true), firstRow: "m1", lastRow: "m12"), .follow)
    }

    func testMidScrollIsPutBackWhereItWas() {
        XCTAssertEqual(ChatScrollMemory.resolve(snap(), firstRow: "m1", lastRow: "m9"), .place(fromTop: 800, newBelow: false))
    }

    func testRowsThatArrivedWhileAwayMarkNewBelowButKeepTheSpot() {
        XCTAssertEqual(ChatScrollMemory.resolve(snap(), firstRow: "m1", lastRow: "m12"), .place(fromTop: 800, newBelow: true))
    }

    func testAChangedFirstRowCannotTrustTheDistance() {
        XCTAssertEqual(ChatScrollMemory.resolve(snap(), firstRow: "m0", lastRow: "m9"), .follow)
        XCTAssertEqual(ChatScrollMemory.resolve(snap(), firstRow: nil, lastRow: nil), .follow)
        XCTAssertEqual(ChatScrollMemory.resolve(snap(first: nil), firstRow: nil, lastRow: nil), .follow)
    }

    func testTopOfTheChatHasNothingToRestore() {
        XCTAssertEqual(ChatScrollMemory.resolve(snap(top: 0), firstRow: "m1", lastRow: "m9"), .follow)
    }

    func testStoreKeepsPerChatAndEvictsTheOldest() {
        var memory = ChatScrollMemory(capacity: 2)
        memory.save(snap(top: 10), for: "a")
        memory.save(snap(top: 20), for: "b")
        XCTAssertEqual(memory.snapshot(for: "a")?.fromTop, 10)  // a is now the newest
        memory.save(snap(top: 30), for: "c")
        XCTAssertNil(memory.snapshot(for: "b"))
        XCTAssertEqual(memory.snapshot(for: "a")?.fromTop, 10)
        XCTAssertEqual(memory.snapshot(for: "c")?.fromTop, 30)
        XCTAssertNil(memory.snapshot(for: "never"))
        XCTAssertEqual(memory.count, 2)
    }

    func testSavingAgainReplaces() {
        var memory = ChatScrollMemory()
        memory.save(snap(top: 10), for: "a")
        memory.save(snap(following: true, top: 0), for: "a")
        XCTAssertEqual(memory.snapshot(for: "a")?.following, true)
        memory.forget("a")
        XCTAssertNil(memory.snapshot(for: "a"))
    }
}
