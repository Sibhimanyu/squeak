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

final class StreamTabsFileTests: XCTestCase {
    func testFileTabsKeepTheirPlaceAmongThreadsAcrossRelaunch() throws {
        var t = StreamTabs()
        t.open(.thread("a"), in: "w")
        t.open(.file("docs/x.md"), in: "w")
        t.open(.thread("b"), in: "w")
        t.open(.file("/tmp/y.txt"), in: "w")
        let back = try JSONDecoder().decode(StreamTabs.self, from: JSONEncoder().encode(t))
        XCTAssertEqual(back.tabs("w"), [.thread("a"), .file("docs/x.md"), .thread("b"), .file("/tmp/y.txt")])
        XCTAssertEqual(back.fileTabs("w"), ["docs/x.md", "/tmp/y.txt"])
        XCTAssertEqual(back.selected("w"), .file("/tmp/y.txt"))
    }

    func testAFileThatIsGoneIsForgottenOnRestoreAndTheRestKeepOrder() {
        var t = StreamTabs()
        for tab in [StreamTab.thread("a"), .file("gone.md"), .file("kept.md"), .thread("b")] { t.open(tab, in: "w") }
        t.select(.file("gone.md"), in: "w")
        t.prune(exists: { $0.kind != .file || $0.id != "gone.md" })
        XCTAssertEqual(t.tabs("w"), [.thread("a"), .file("kept.md"), .thread("b")])
        XCTAssertEqual(t.selected("w"), .file("kept.md"))
    }

    func testStripResolvesSavedOrderAndAppendsUnsavedOpenFiles() {
        var t = StreamTabs()
        for tab in [StreamTab.thread("a"), .file("x.md"), .thread("gone"), .thread("b")] { t.open(tab, in: "w") }
        let strip = t.strip("w", hasThread: { $0 != "gone" }, isOpen: { $0 == "x.md" || $0 == "new.md" }, openFiles: ["x.md", "new.md"])
        XCTAssertEqual(strip, [.thread("a"), .file("x.md"), .thread("b"), .file("new.md")])
    }

    func testReopeningASavedFileDoesNotMoveIt() {
        var t = StreamTabs()
        for tab in [StreamTab.file("x.md"), .thread("a")] { t.open(tab, in: "w") }
        t.open(.file("x.md"), in: "w")
        XCTAssertEqual(t.tabs("w"), [.file("x.md"), .thread("a")])
    }

    func testASavedStripWithoutTheNewThreadGetsItsTabAfterTheSelectedOne() {
        var t = StreamTabs()
        t.open(.thread("old"), in: "w")
        XCTAssertTrue(t.ensureOpen(.thread("new"), in: "w"))
        XCTAssertEqual(t.tabs("w"), [.thread("old"), .thread("new")])
        XCTAssertEqual(t.selected("w"), .thread("new"))
        // Even before the list resolves it, the strip carries it; once the list has it, it is drawn.
        XCTAssertEqual(t.strip("w", hasThread: { _ in true }, isOpen: { _ in false }, openFiles: []), [.thread("old"), .thread("new")])
        XCTAssertFalse(t.ensureOpen(.thread("new"), in: "w"))
    }

    func testEnsureOpenSelectsAnExistingTabWithoutMovingIt() {
        var t = StreamTabs()
        for id in ["a", "b", "c"] { t.open(.thread(id), in: "w") }
        t.select(.thread("c"), in: "w")
        XCTAssertTrue(t.ensureOpen(.thread("a"), in: "w"))
        XCTAssertEqual(t.tabs("w"), [.thread("a"), .thread("b"), .thread("c")])
        XCTAssertEqual(t.selected("w"), .thread("a"))
    }
}
