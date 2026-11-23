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

    func testArtifactTabsAreKeptApartFromThreadsAndFiles() {
        var t = StreamTabs()
        t.open(.thread("a"), in: "w")
        t.open(.artifact(pond: "p", path: "/r/x y.psd"), in: "w")
        t.open(.artifact(pond: "p", path: "/r/x y.psd"), in: "w")
        t.open(.file("f.txt"), in: "w")
        XCTAssertEqual(t.artifactTabs("w").count, 1)
        XCTAssertEqual(t.artifactTabs("w").first?.pond, "p")
        XCTAssertEqual(t.artifactTabs("w").first?.path, "/r/x y.psd")
        let strip = t.strip("w", hasThread: { _ in true }, isOpen: { _ in true }, openFiles: [])
        XCTAssertEqual(strip, [.thread("a"), .file("f.txt")])
        // Pruning threads or files leaves artifact tabs alone; closing one removes only it.
        t.prune(exists: { $0.kind != .thread })
        XCTAssertEqual(t.artifactTabs("w").count, 1)
        t.close(.artifact(pond: "p", path: "/r/x y.psd"), in: "w")
        XCTAssertTrue(t.artifactTabs("w").isEmpty)
        XCTAssertEqual(ArtifactTabID.parse(ArtifactTabID.make(pond: "p", path: "a|b"))?.path, "a|b")
    }

    // MARK: Preview tab

    private let a = StreamTab.thread("a")
    private let f1 = StreamTab.file("one.md"), f2 = StreamTab.file("two.md"), f3 = StreamTab.file("three.md")
    private let art = StreamTab.artifact(pond: "p", path: "/r/x.psd")

    func testSingleClickReplacesThePreview() {
        var t = StreamTabs()
        t.open(a, in: "w")
        XCTAssertNil(t.openPreview(f1, in: "w"))
        XCTAssertEqual(t.openPreview(f2, in: "w"), f1)
        XCTAssertEqual(t.tabs("w"), [a, f2])
        XCTAssertEqual(t.previewTab("w"), f2)
        XCTAssertEqual(t.selected("w"), f2)
        XCTAssertEqual(t.openPreview(art, in: "w"), f2)
        XCTAssertEqual(t.tabs("w"), [a, art])
    }

    func testPinnedIsNeverReplacedAndNextClickMakesANewPreview() {
        var t = StreamTabs()
        t.openPreview(f1, in: "w")
        XCTAssertTrue(t.pin(f1, in: "w"))
        XCTAssertFalse(t.isPreview(f1, in: "w"))
        XCTAssertNil(t.openPreview(f2, in: "w"))
        XCTAssertEqual(t.tabs("w"), [f1, f2])
        XCTAssertEqual(t.openPreview(f3, in: "w"), f2)
        XCTAssertEqual(t.tabs("w"), [f1, f3])
        XCTAssertFalse(t.pin(f1, in: "w"))
    }

    func testReopeningAPinnedOrPreviewItemJustFocusesIt() {
        var t = StreamTabs()
        t.openPreview(f1, in: "w"); t.pin(f1, in: "w")
        t.openPreview(f2, in: "w")
        XCTAssertNil(t.openPreview(f1, in: "w"))
        XCTAssertEqual(t.selected("w"), f1)
        XCTAssertEqual(t.tabs("w"), [f1, f2])
        XCTAssertEqual(t.previewTab("w"), f2)
        XCTAssertNil(t.openPreview(f2, in: "w"))
        XCTAssertEqual(t.previewTab("w"), f2)
    }

    func testClosingThePreviewFreesTheSlot() {
        var t = StreamTabs()
        t.open(a, in: "w")
        t.openPreview(f1, in: "w")
        t.close(f1, in: "w")
        XCTAssertNil(t.previewTab("w"))
        XCTAssertNil(t.openPreview(f2, in: "w"))
        XCTAssertEqual(t.tabs("w"), [a, f2])
    }

    func testThreadsAreNeverPreviews() {
        var t = StreamTabs()
        t.openPreview(f1, in: "w")
        XCTAssertNil(t.openPreview(a, in: "w"))
        XCTAssertEqual(t.previewTab("w"), f1)
        XCTAssertFalse(t.isPreview(a, in: "w"))
        XCTAssertFalse(t.pin(a, in: "w"))
    }

    func testPreviewIsPerWorkspaceAndSurvivesPruneOnlyWhileItsTabDoes() {
        var t = StreamTabs()
        t.openPreview(f1, in: "w"); t.openPreview(f2, in: "v")
        XCTAssertEqual(t.previewTab("w"), f1)
        XCTAssertEqual(t.previewTab("v"), f2)
        t.prune(exists: { $0 != f1 })
        XCTAssertNil(t.previewTab("w"))
        XCTAssertEqual(t.previewTab("v"), f2)
    }

    func testPreviewFlagPersists() throws {
        var t = StreamTabs()
        t.open(a, in: "w"); t.openPreview(f1, in: "w")
        let back = try JSONDecoder().decode(StreamTabs.self, from: JSONEncoder().encode(t))
        XCTAssertEqual(back, t)
        XCTAssertTrue(back.isPreview(f1, in: "w"))
        XCTAssertEqual(back.openPreviewReplacedForTest(f2), f1)
    }

    func testOldSavedStripsWithoutAPreviewStillDecode() throws {
        var t = StreamTabs()
        t.open(a, in: "w"); t.open(f1, in: "w")
        var json = String(data: try JSONEncoder().encode(t), encoding: .utf8)!
        json = json.replacingOccurrences(of: ",\"preview\":null", with: "")
        let back = try JSONDecoder().decode(StreamTabs.self, from: Data(json.utf8))
        XCTAssertEqual(back.tabs("w"), [a, f1])
        XCTAssertNil(back.previewTab("w"))
    }
}

private extension StreamTabs {
    func openPreviewReplacedForTest(_ tab: StreamTab) -> StreamTab? {
        var copy = self
        return copy.openPreview(tab, in: "w")
    }
}
