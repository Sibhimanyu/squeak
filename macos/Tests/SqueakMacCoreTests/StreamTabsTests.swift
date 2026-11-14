import XCTest
@testable import SqueakMacCore

final class StreamTabsTests: XCTestCase {
    private let a = StreamTab.thread("a"), b = StreamTab.thread("b"), c = StreamTab.thread("c"), f = StreamTab.file("x.md")

    func testOpenAddsOnceAndSelects() {
        var t = StreamTabs()
        t.open(a, in: "w"); t.open(b, in: "w"); t.open(a, in: "w")
        XCTAssertEqual(t.tabs("w"), [a, b])
        XCTAssertEqual(t.selected("w"), a)
    }

    func testOpenInsertsAfterCurrentAndKeepsOrder() {
        var t = StreamTabs()
        t.open(a, in: "w"); t.open(b, in: "w"); t.select(a, in: "w")
        t.open(c, in: "w")
        XCTAssertEqual(t.tabs("w"), [a, c, b])
        t.open(f, in: "w")
        XCTAssertEqual(t.tabs("w"), [a, c, f, b])
    }

    func testSeedAppliesOnlyToFirstOpen() {
        var t = StreamTabs()
        t.open(c, in: "w", seed: [a, b])
        t.open(f, in: "w", seed: [])
        XCTAssertEqual(t.tabs("w"), [a, b, c, f])
    }

    func testCloseSelectsNeighbour() {
        var t = StreamTabs()
        t.open(a, in: "w"); t.open(b, in: "w"); t.open(c, in: "w")
        t.select(b, in: "w")
        XCTAssertEqual(t.close(b, in: "w"), c)
        XCTAssertEqual(t.close(c, in: "w"), a)
        XCTAssertNil(t.close(a, in: "w"))
        XCTAssertEqual(t.tabs("w"), [])
        XCTAssertTrue(t.hasStrip("w"))
    }

    func testClosingUnselectedKeepsSelection() {
        var t = StreamTabs()
        t.open(a, in: "w"); t.open(b, in: "w")
        XCTAssertEqual(t.close(a, in: "w"), b)
        XCTAssertEqual(t.tabs("w"), [b])
    }

    func testNavigationAwayAndBackPreserves() throws {
        var t = StreamTabs()
        t.open(a, in: "w"); t.open(b, in: "w")
        // Home and back touch no strip; an old thread opened from the Dashboard adds a tab.
        t.open(c, in: "w")
        XCTAssertEqual(t.tabs("w"), [a, b, c])
        let back = try JSONDecoder().decode(StreamTabs.self, from: JSONEncoder().encode(t))
        XCTAssertEqual(back, t)
    }

    func testRestoreDropsMissing() {
        var t = StreamTabs()
        t.open(a, in: "w"); t.open(b, in: "w"); t.open(f, in: "w"); t.select(b, in: "w")
        XCTAssertTrue(t.prune { $0 != b })
        XCTAssertEqual(t.tabs("w"), [a, f])
        XCTAssertEqual(t.selected("w"), f)
        XCTAssertFalse(t.prune { _ in true })
    }

    func testTwoStreamsAreSeparate() {
        var t = StreamTabs()
        t.open(a, in: "w1"); t.open(b, in: "w2"); t.open(c, in: "w2")
        t.close(c, in: "w2")
        XCTAssertEqual(t.tabs("w1"), [a])
        XCTAssertEqual(t.tabs("w2"), [b])
    }

    func testMove() {
        var t = StreamTabs()
        t.open(a, in: "w"); t.open(b, in: "w"); t.open(c, in: "w")
        XCTAssertTrue(t.move(c, before: a, in: "w"))
        XCTAssertEqual(t.tabs("w"), [c, a, b])
    }
}
