import XCTest
@testable import SqueakMacCore

final class DockPresentationTests: XCTestCase {
    func testBottomPlacement() {
        var l = DockLayout.standard
        XCTAssertEqual(DockBottomPlacement.of(l), .underRight)
        l.right.collapsed = true
        XCTAssertEqual(DockBottomPlacement.of(l), .underCentre)
        l.right.collapsed = false
        l.move(.terminal, to: .right)
        XCTAssertEqual(DockBottomPlacement.of(l), .none)
        l.move(.pond, to: .bottom); l.move(.code, to: .bottom)
        XCTAssertEqual(DockBottomPlacement.of(l), .underRight)
        l.close(.terminal)
        XCTAssertEqual(DockBottomPlacement.of(l), .underCentre)
    }

    func testPlusAction() {
        var l = DockLayout.standard
        XCTAssertEqual(DockPlusAction.of(zone: .centre, layout: l), .newChat)
        XCTAssertEqual(DockPlusAction.of(zone: .bottom, layout: l), .newTerminal)
        XCTAssertEqual(DockPlusAction.of(zone: .right, layout: l), .none)
        l.close(.code)
        XCTAssertEqual(DockPlusAction.of(zone: .right, layout: l), .showHidden([.code]))
        l.move(.terminal, to: .centre)
        XCTAssertEqual(DockPlusAction.of(zone: .centre, layout: l), .newTerminal)
        l.selectChats()
        XCTAssertEqual(DockPlusAction.of(zone: .centre, layout: l), .newChat)
    }

    func testPayload() {
        for p in DockPanel.allCases { XCTAssertEqual(DockPanelPayload.decode(DockPanelPayload.encode(p)), p) }
        XCTAssertNil(DockPanelPayload.decode("chat-abc"))
        XCTAssertNil(DockPanelPayload.decode("squeak-dock-panel:nope"))
    }

    func testToggleRight() {
        var l = DockLayout.standard
        l.toggleRight()
        XCTAssertTrue(l.right.collapsed)
        l.toggleRight()
        XCTAssertFalse(l.right.collapsed)
        l.move(.pond, to: .centre); l.move(.code, to: .bottom)
        XCTAssertTrue(l.right.panels.isEmpty)
        l.toggleRight()
        XCTAssertEqual(l.right.panels, [.pond])
        var h = DockLayout.standard
        h.close(.pond); h.close(.code)
        h.toggleRight()
        XCTAssertEqual(h.right.panels, [.pond])
    }

    func testDismissAndShowingAndZen() {
        var l = DockLayout.standard
        l.show(.terminal)
        XCTAssertTrue(l.isShowing(.terminal))
        l.dismiss(.terminal)
        XCTAssertFalse(l.isShowing(.terminal))
        XCTAssertEqual(l.zone(of: .terminal), .bottom)
        l.move(.terminal, to: .right)
        l.dismiss(.terminal)
        XCTAssertNil(l.zone(of: .terminal))
        let z = DockLayout.standard.zen()
        XCTAssertTrue(z.right.collapsed && z.bottom.collapsed)
        XCTAssertEqual(z.right.panels, DockLayout.standard.right.panels)
    }

    @MainActor func testStoreMigratesPersistsAndKeepsLegacyKeys() {
        let d = UserDefaults(suiteName: "dock-test-\(UUID().uuidString)")!
        d.set(true, forKey: "inspectorOpen"); d.set(true, forKey: "inspectorCodeView"); d.set(true, forKey: "terminalOpen")
        d.set(400.0, forKey: "inspectorWidth")
        let s = DockStore(defaults: d)
        XCTAssertEqual(s.layout.right.selected, .code)
        XCTAssertFalse(s.layout.right.collapsed)
        XCTAssertFalse(s.layout.bottom.collapsed)
        XCTAssertEqual(s.layout.right.size, 400)
        XCTAssertTrue(d.bool(forKey: "inspectorOpen"))
        s.update { $0.move(.pond, to: .bottom) }
        s.edit { $0.saveNew(name: "Mine") }
        let again = DockStore(defaults: d)
        XCTAssertEqual(again.workspaces, s.workspaces)
        XCTAssertEqual(again.workspaces.active.name, "Mine")
        XCTAssertEqual(again.layout.zone(of: .pond), .bottom)
    }

    @MainActor func testStoreFreshDefaultsAndDrop() {
        let s = DockStore(defaults: UserDefaults(suiteName: "dock-test-\(UUID().uuidString)")!)
        XCTAssertEqual(s.layout.right.collapsed, true)
        s.dragging = .panel(.pond)
        XCTAssertTrue(s.drop(.panel(.pond), to: .centre))
        XCTAssertNil(s.dragging)
        XCTAssertEqual(s.layout.centre.panels, [.pond])
        XCTAssertEqual(s.layout.centre.selected, .pond)
    }
}
