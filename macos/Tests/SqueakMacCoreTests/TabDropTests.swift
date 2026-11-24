import XCTest
@testable import SqueakMacCore

final class TabDropTests: XCTestCase {
    private let order = ["a", "b", "c", "d"]

    func testLeftHalfLandsBeforeAndRightHalfAfter() {
        XCTAssertEqual(TabDrop.landing(in: order, dragged: "d", over: "b", x: 10, width: 100), .init(anchor: "b", side: .before))
        XCTAssertEqual(TabDrop.landing(in: order, dragged: "a", over: "c", x: 90, width: 100), .init(anchor: "c", side: .after))
    }

    func testTheMiddleBelongsToTheRightHalf() {
        XCTAssertEqual(TabDrop.side(x: 50, width: 100), .after)
        XCTAssertEqual(TabDrop.side(x: 49.9, width: 100), .before)
        XCTAssertEqual(TabDrop.side(x: 10, width: 0), .before)
    }

    func testOwnSlotIsANoOp() {
        XCTAssertNil(TabDrop.landing(in: order, dragged: "b", over: "b", x: 10, width: 100))
        XCTAssertNil(TabDrop.landing(in: order, dragged: "b", over: "b", x: 90, width: 100))
    }

    func testTheGapItAlreadySitsInIsANoOp() {
        // b is right before c: before c and after a both leave it where it is.
        XCTAssertNil(TabDrop.landing(in: order, dragged: "b", over: "c", x: 10, width: 100))
        XCTAssertNil(TabDrop.landing(in: order, dragged: "b", over: "a", x: 90, width: 100))
        // The far halves do move it.
        XCTAssertNotNil(TabDrop.landing(in: order, dragged: "b", over: "c", x: 90, width: 100))
        XCTAssertNotNil(TabDrop.landing(in: order, dragged: "b", over: "a", x: 10, width: 100))
    }

    func testEndsOfTheStrip() {
        XCTAssertEqual(TabDrop.landing(in: order, dragged: "b", over: "d", x: 99, width: 100), .init(anchor: "d", side: .after))
        XCTAssertEqual(TabDrop.landing(in: order, dragged: "c", over: "a", x: 1, width: 100), .init(anchor: "a", side: .before))
        // The last tab dropped after itself, or the first before itself, is nothing to do.
        XCTAssertNil(TabDrop.landing(in: order, dragged: "d", over: "d", x: 99, width: 100))
        XCTAssertNil(TabDrop.landing(in: order, dragged: "a", over: "b", x: 1, width: 100))
    }

    func testATabFromAnotherStripAlwaysLands() {
        XCTAssertEqual(TabDrop.landing(in: order, dragged: "z", over: "b", x: 10, width: 100), .init(anchor: "b", side: .before))
        XCTAssertEqual(TabDrop.landing(in: order, dragged: nil, over: "b", x: 90, width: 100), .init(anchor: "b", side: .after))
    }

    func testInsertBeforeNamesTheNeighbourOrTheEnd() {
        XCTAssertEqual(TabDrop.insertBefore(in: order, dragged: "d", landing: .init(anchor: "b", side: .before)), "b")
        XCTAssertEqual(TabDrop.insertBefore(in: order, dragged: "a", landing: .init(anchor: "b", side: .after)), "c")
        XCTAssertNil(TabDrop.insertBefore(in: order, dragged: "a", landing: .init(anchor: "d", side: .after)))
        // The dragged tab is skipped when it is the next neighbour.
        XCTAssertEqual(TabDrop.insertBefore(in: order, dragged: "c", landing: .init(anchor: "b", side: .after)), "d")
    }

    func testApplyingMatchesTheLanding() {
        XCTAssertEqual(TabDrop.applying(.init(anchor: "b", side: .after), moving: "a", in: order), ["b", "a", "c", "d"])
        XCTAssertEqual(TabDrop.applying(.init(anchor: "b", side: .before), moving: "d", in: order), ["a", "d", "b", "c"])
        XCTAssertEqual(TabDrop.applying(.init(anchor: "d", side: .after), moving: "a", in: order), ["b", "c", "d", "a"])
        XCTAssertEqual(TabDrop.applying(.init(anchor: "a", side: .before), moving: "c", in: order), ["c", "a", "b", "d"])
    }

    func testKeyboardStepMovesOnePlaceAndStopsAtTheEnds() {
        XCTAssertEqual(TabDrop.step(in: order, tab: "c", by: -1), .init(anchor: "b", side: .before))
        XCTAssertEqual(TabDrop.step(in: order, tab: "c", by: 1), .init(anchor: "d", side: .after))
        XCTAssertNil(TabDrop.step(in: order, tab: "a", by: -1))
        XCTAssertNil(TabDrop.step(in: order, tab: "d", by: 1))
        XCTAssertNil(TabDrop.step(in: order, tab: "z", by: 1))
        let l = TabDrop.step(in: order, tab: "c", by: -1)!
        XCTAssertEqual(TabDrop.applying(l, moving: "c", in: order), ["a", "c", "b", "d"])
    }

    // MARK: Saved strip

    func testStreamTabsMoveAfterAndBefore() {
        let a = StreamTab.thread("a"), f = StreamTab.file("x"), v = StreamTab.artifact(pond: "p", path: "/c.html")
        var t = StreamTabs()
        t.open(a, in: "w"); t.open(f, in: "w"); t.open(v, in: "w")
        XCTAssertEqual(t.tabs("w"), [a, f, v])
        XCTAssertTrue(t.move(a, to: .init(anchor: v, side: .after), in: "w"))
        XCTAssertEqual(t.tabs("w"), [f, v, a])
        XCTAssertTrue(t.move(v, to: .init(anchor: f, side: .before), in: "w"))
        XCTAssertEqual(t.tabs("w"), [v, f, a])
        // No change, a missing tab, itself: nothing moves.
        XCTAssertFalse(t.move(v, to: .init(anchor: f, side: .before), in: "w"))
        XCTAssertFalse(t.move(v, to: .init(anchor: v, side: .after), in: "w"))
        XCTAssertFalse(t.move(.thread("gone"), to: .init(anchor: v, side: .after), in: "w"))
    }

    func testStripCanCarryCanvasTabsInPlace() {
        let a = StreamTab.thread("a"), v = StreamTab.artifact(pond: "p", path: "/c.html"), b = StreamTab.thread("b")
        var t = StreamTabs()
        t.open(a, in: "w"); t.open(v, in: "w"); t.open(b, in: "w")
        let plain = t.strip("w", hasThread: { _ in true }, isOpen: { _ in true }, openFiles: [])
        XCTAssertEqual(plain, [a, b])
        let withCanvas = t.strip("w", hasThread: { _ in true }, isOpen: { _ in true }, openFiles: [], withArtifacts: true)
        XCTAssertEqual(withCanvas, [a, v, b])
    }

    func testArtifactDragPayloadRoundTripsAndOnlyTheCentreTakesIt() {
        let text = ArtifactDragPayload.encode(pond: "p", path: "/c.html")
        XCTAssertEqual(ArtifactDragPayload.decode(text), .artifact(pond: "p", path: "/c.html"))
        XCTAssertNil(ArtifactDragPayload.decode("squeak-dock-artifact:nope"))
        XCTAssertNil(DockItemPayload.decode(text))
        XCTAssertEqual(DragKind.sniff(text), .artifact)
        XCTAssertEqual(DragKind.accepted(text, on: .centreStrip), .artifact)
        XCTAssertNil(DragKind.accepted(text, on: .rightStrip))
        XCTAssertNil(DragKind.accepted(text, on: .bottomStrip))
        XCTAssertNil(DragKind.accepted(text, on: .edgeStrip(.right)))
    }

    func testStreamTabOfADockItem() {
        XCTAssertEqual(StreamTab.of(.thread("k")), .thread("k"))
        XCTAssertEqual(StreamTab.of(.file("/x")), .file("/x"))
        XCTAssertNil(StreamTab.of(.panel(.code)))
        XCTAssertNil(StreamTab.of(nil))
    }

    // MARK: Fit

    func testFitIsEaseOutAndInstantUnderReduceMotion() {
        XCTAssertEqual(CanvasFitMotion.progress(elapsed: 0, reduceMotion: false), 0)
        XCTAssertEqual(CanvasFitMotion.progress(elapsed: 5, reduceMotion: false), 1)
        XCTAssertEqual(CanvasFitMotion.progress(elapsed: 0.01, reduceMotion: true), 1)
        // Ease-out: more than half the way at half the time, and never going backwards.
        XCTAssertGreaterThan(CanvasFitMotion.progress(elapsed: CanvasFitMotion.duration / 2, reduceMotion: false), 0.5)
        var last = 0.0
        for i in 0...20 {
            let p = CanvasFitMotion.progress(elapsed: Double(i) * CanvasFitMotion.duration / 20, reduceMotion: false)
            XCTAssertGreaterThanOrEqual(p, last); last = p
        }
    }

    func testFitFrameEndsExactlyOnTheTarget() {
        let from = CanvasFitMotion.Pose(magnification: 2, originX: 100, originY: 40)
        let to = CanvasFitMotion.Pose(magnification: 0.5, originX: 0, originY: 10)
        XCTAssertEqual(CanvasFitMotion.frame(from: from, to: to, progress: 0), from)
        XCTAssertEqual(CanvasFitMotion.frame(from: from, to: to, progress: 1), to)
        let mid = CanvasFitMotion.frame(from: from, to: to, progress: 0.5)
        XCTAssertEqual(mid.magnification, 1.25, accuracy: 1e-9)
        XCTAssertEqual(mid.originX, 50, accuracy: 1e-9)
    }
}

@MainActor final class DockSiblingsTests: XCTestCase {
    func testSiblingsAreTheSameKindInTheZone() {
        let dock = DockStore(defaults: UserDefaults(suiteName: "sib-\(UUID().uuidString)")!)
        dock.moveFile("/a", to: .right); dock.moveFile("/b", to: .right); dock.moveThread("t", to: .right)
        XCTAssertEqual(dock.siblings(of: .file("/a"), in: .right), [.file("/a"), .file("/b")])
        XCTAssertEqual(dock.siblings(of: .thread("t"), in: .right), [.thread("t")])
        XCTAssertEqual(dock.siblings(of: .file("/a"), in: .bottom), [])
    }
}
