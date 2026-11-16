import XCTest
@testable import SqueakMacCore

final class DockFilesTests: XCTestCase {
    func testMoveSelectsAndReorders() {
        var f = DockFiles()
        XCTAssertEqual(f.zone(of: "/a"), .centre)
        f.move("/a", to: .right); f.move("/b", to: .right)
        XCTAssertEqual(f.files(in: .right), ["/a", "/b"])
        XCTAssertEqual(f.selected[.right], "/b")
        f.move("/b", to: .right, before: "/a")
        XCTAssertEqual(f.files(in: .right), ["/b", "/a"])
        f.move("/a", to: .bottom)
        XCTAssertEqual(f.files(in: .right), ["/b"])
        XCTAssertEqual(f.selected[.right], "/b")
        XCTAssertEqual(f.zone(of: "/a"), .bottom)
        f.move("/a", to: .centre)
        XCTAssertEqual(f.zone(of: "/a"), .centre)
        XCTAssertFalse(f.hasFiles(in: .bottom))
    }

    func testCloseFallsToNextThenPreviousThenNil() {
        var f = DockFiles()
        for p in ["/a", "/b", "/c"] { f.move(p, to: .right) }
        f.select("/b"); f.close("/b")
        XCTAssertEqual(f.selected[.right], "/c")
        f.close("/c")
        XCTAssertEqual(f.selected[.right], "/a")
        f.close("/a")
        XCTAssertNil(f.selected[.right])
        XCTAssertTrue(f.files(in: .right).isEmpty)
    }

    func testPruneDropsFilesNoLongerOpen() {
        var f = DockFiles()
        f.move("/a", to: .right); f.move("/b", to: .right); f.move("/c", to: .bottom)
        let p = f.pruned(keeping: ["/a", "/c"])
        XCTAssertEqual(p.files(in: .right), ["/a"])
        XCTAssertNil(p.selected[.right])
        XCTAssertEqual(p.files(in: .bottom), ["/c"])
        XCTAssertEqual(f.pruned(keeping: []), DockFiles())
    }

    func testPayload() {
        XCTAssertEqual(DockItemPayload.decode(DockItemPayload.encode(.file("/x/y z.swift"))), .file("/x/y z.swift"))
        XCTAssertEqual(DockItemPayload.decode(DockItemPayload.encode(.panel(.code))), .panel(.code))
        XCTAssertNil(DockItemPayload.decode("squeak-dock-file:"))
        XCTAssertNil(DockItemPayload.decode("chat-1"))
    }

    func testZoneVisibleWithOnlyFilesAndPlacement() {
        var l = DockLayout.standard
        l.close(.pond); l.close(.code); l.close(.terminal)
        var f = DockFiles()
        XCTAssertEqual(DockBottomPlacement.of(l, files: f), .none)
        f.move("/a", to: .bottom)
        XCTAssertEqual(DockBottomPlacement.of(l, files: f), .underCentre)
        f.move("/b", to: .right)
        XCTAssertTrue(l.isZoneVisible(.right, files: f))
        XCTAssertEqual(DockBottomPlacement.of(l, files: f), .underRight)
    }

    @MainActor func testStorePanelAndFileShareAZone() {
        let s = DockStore(defaults: UserDefaults(suiteName: "dock-files-\(UUID().uuidString)")!)
        s.moveFile("/a", to: .right)
        XCTAssertEqual(s.layout.right.panels, [.pond, .code])
        XCTAssertEqual(s.files.selected[.right], "/a")
        XCTAssertFalse(s.layout.right.collapsed)
        s.selectPanel(.code, in: .right)
        XCTAssertNil(s.files.selected[.right])
        XCTAssertEqual(s.layout.right.selected, .code)
        s.selectFile("/a")
        XCTAssertEqual(s.files.selected[.right], "/a")
        s.update { $0.select(.pond) }
        XCTAssertNil(s.files.selected[.right])
        XCTAssertTrue(s.drop(.file("/b"), to: .bottom))
        XCTAssertEqual(s.files.zone(of: "/b"), .bottom)
        XCTAssertTrue(s.drop(.file("/b"), to: .centre))
        XCTAssertNil(s.layout.centre.selected)
        s.pruneFiles(keeping: [])
        XCTAssertEqual(s.files, DockFiles())
        let again = DockStore(defaults: UserDefaults(suiteName: "dock-files-\(UUID().uuidString)")!)
        XCTAssertEqual(again.files, DockFiles())
    }
}
