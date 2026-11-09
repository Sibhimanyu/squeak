import XCTest
@testable import SqueakUI

final class RowWindowTests: XCTestCase {
    private struct R: Identifiable { let id: String }
    private func rows(_ n: Int, _ prefix: String = "r") -> [R] { (0..<n).map { R(id: "\(prefix)\($0)") } }
    private let first = RowWindow.initial
    private let batch = RowWindow.batch

    func testShortChatMountsEverything() {
        var w = RowWindow()
        let r = rows(first)
        w.place(r)
        XCTAssertEqual(w.slice(r).count, first)
        XCTAssertEqual(w.hidden(r), 0)
        XCTAssertFalse(w.grow(r))
    }

    func testLongChatOpensOnItsNewestRows() {
        var w = RowWindow()
        let r = rows(200)
        XCTAssertEqual(w.slice(r).first?.id, "r\(200 - first)", "before placing, the same rows place picks")
        w.place(r)
        XCTAssertEqual(w.slice(r).first?.id, "r\(200 - first)")
        XCTAssertEqual(w.hidden(r), 200 - first)
    }

    func testRowsAtTheEndMountWithoutSlidingTheTop() {
        var w = RowWindow()
        w.place(rows(100))
        let more = rows(105)
        XCTAssertEqual(w.slice(more).first?.id, "r\(100 - first)")
        XCTAssertEqual(w.slice(more).count, first + 5)
    }

    func testGrowAddsABatchAndStopsAtTheTop() {
        var w = RowWindow()
        let total = first + batch + 3
        let r = rows(total)
        w.place(r)
        XCTAssertEqual(w.slice(r).count, first)
        XCTAssertTrue(w.grow(r))
        XCTAssertEqual(w.slice(r).count, first + batch)
        XCTAssertTrue(w.grow(r))
        XCTAssertEqual(w.slice(r).count, total)
        XCTAssertEqual(w.hidden(r), 0)
        XCTAssertFalse(w.grow(r))
    }

    func testOlderRowsPrependedStayHiddenUntilGrown() {
        var w = RowWindow()
        w.place(rows(40))
        let longer = rows(30, "old") + rows(40)
        XCTAssertEqual(w.slice(longer).count, first)
        XCTAssertEqual(w.hidden(longer), 70 - first)
        XCTAssertTrue(w.grow(longer))
        XCTAssertEqual(w.slice(longer).count, first + batch)
    }

    func testLostStartIsPlacedAgain() {
        var w = RowWindow()
        w.place(rows(100))
        let rebuilt = rows(100, "x")
        w.replaceIfLost(rebuilt)
        XCTAssertEqual(w.slice(rebuilt).first?.id, "x\(100 - first)")
    }

    func testNoRowsPlacesNothing() {
        var w = RowWindow()
        w.place([R]())
        XCTAssertFalse(w.placed)
    }
}
