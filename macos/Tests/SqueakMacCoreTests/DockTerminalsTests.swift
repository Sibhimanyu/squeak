import XCTest
@testable import SqueakMacCore

final class DockTerminalsTests: XCTestCase {
    private let a = UUID(), b = UUID(), c = UUID()

    func testSyncPlacesNewShellsInHomeAndPrunesGoneOnes() {
        var t = DockTerminals()
        t.sync(live: [a, b], home: .bottom)
        XCTAssertEqual(t.terminals(in: .bottom), [a, b])
        t.move(c, to: .right)  // unknown to the registry: pruned
        t.sync(live: [a, b], home: .bottom)
        XCTAssertEqual(t.terminals(in: .right), [])
        t.sync(live: [b], home: .bottom)
        XCTAssertEqual(t.terminals(in: .bottom), [b])
        XCTAssertEqual(t.pruned(keeping: []).placed.values.flatMap { $0 }, [])
    }

    func testMoveAndReorder() {
        var t = DockTerminals()
        t.sync(live: [a, b, c], home: .bottom)
        t.move(a, to: .right)
        XCTAssertEqual(t.zone(of: a), .right)
        XCTAssertEqual(t.shown(in: .right), a)
        t.move(c, to: .bottom, before: b)
        XCTAssertEqual(t.terminals(in: .bottom), [c, b])
        t.move(b, to: .bottom, before: b)  // same place
        XCTAssertEqual(t.terminals(in: .bottom), [c, b])
        t.move(c, to: .centre)
        XCTAssertEqual(t.zone(of: c), .centre)
        XCTAssertEqual(t.terminals(in: .bottom), [b])
    }

    func testCloseFallsNextThenPreviousThenNothing() {
        var t = DockTerminals()
        t.sync(live: [a, b, c], home: .right)
        t.select(b); t.close(b)
        XCTAssertEqual(t.shown(in: .right), c)
        t.close(c)
        XCTAssertEqual(t.shown(in: .right), a)
        t.close(a)
        XCTAssertNil(t.shown(in: .right))
        XCTAssertFalse(t.has(in: .right))
    }

    func testNewShellPlacementFollowsThePanel() {
        var layout = DockLayout.standard
        XCTAssertEqual(layout.terminalHome, layout.zone(of: .terminal) ?? .bottom)
        layout.move(.terminal, to: .right)
        XCTAssertEqual(layout.terminalHome, .right)
        layout.close(.terminal)
        XCTAssertEqual(layout.terminalHome, .bottom)
        var t = DockTerminals()
        t.open(a, in: layout.terminalHome)
        XCTAssertEqual(t.zone(of: a), .bottom)
        XCTAssertEqual(t.shown(in: .bottom), a)
    }

    func testMixedZonesWithPanelsFilesAndTerminals() {
        var layout = DockLayout.standard
        layout.move(.code, to: .bottom)
        var files = DockFiles()
        files.move("/x", to: .bottom)
        var t = DockTerminals()
        t.sync(live: [a], home: .bottom)
        XCTAssertTrue(layout.isZoneVisible(.bottom, files: files, terminals: t))
        t.deselect(.bottom)
        XCTAssertNil(t.shown(in: .bottom))
        XCTAssertEqual(files.selected[.bottom], "/x")
        t.select(a)
        XCTAssertEqual(t.shown(in: .bottom), a)
        var onlyShells = DockTerminals()
        onlyShells.sync(live: [b], home: .right)
        var empty = DockLayout.standard
        empty.right.panels = []
        XCTAssertFalse(empty.isZoneVisible(.right, files: DockFiles()))
        XCTAssertTrue(empty.isZoneVisible(.right, files: DockFiles(), terminals: onlyShells))
        XCTAssertEqual(DockBottomPlacement.of(empty, files: DockFiles(), terminals: onlyShells), .underRight)
    }

    func testToggleZoneFindsSelectedOrLast() {
        var t = DockTerminals()
        XCTAssertNil(t.toggleZone())
        t.sync(live: [a], home: .bottom)
        XCTAssertEqual(t.toggleZone(), .bottom)
        t.move(a, to: .right)
        t.deselect(.right)
        XCTAssertEqual(t.toggleZone(), .right)
    }

    func testPayloadRoundTripThroughString() {
        for item in [DockItem.terminal(a), .file("/p/q.swift"), .panel(.code)] {
            XCTAssertEqual(DockItemPayload.decode(DockItemPayload.encode(item)), item)
        }
        XCTAssertTrue(DockItemPayload.encode(.terminal(a)).hasPrefix("squeak-dock-terminal:"))
        XCTAssertNil(DockItemPayload.decode("squeak-dock-terminal:not-a-uuid"))
    }

    func testChatKeyAndPondAreNotDockItems() {
        XCTAssertNil(DockItemPayload.decode("squeak-native:123"))
        XCTAssertNil(DockItemPayload.decode("pond:abc"))
        XCTAssertNil(DockItemPayload.decode(""))
    }

    @MainActor func testTerminalsAreNotSavedInWorkspaces() throws {
        let store = DockStore(defaults: UserDefaults(suiteName: "dockterm-\(UUID())")!)
        do {
            store.syncTerminals(folder: "/f", live: [a, b])
            XCTAssertEqual(store.activeTerminals.terminals(in: .bottom), [a, b])
            let data = try? JSONEncoder().encode(store.workspaces)
            let text = String(data: data ?? Data(), encoding: .utf8) ?? ""
            XCTAssertFalse(text.contains(a.uuidString))
        }
    }
}
