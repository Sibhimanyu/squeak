import XCTest
@testable import SqueakMacCore

final class WindowMenuTests: XCTestCase {
    private func layout(_ action: WindowMenu.Action) -> DockLayout {
        if case .layout(let l) = action { return l }
        XCTFail("expected a layout"); return .standard
    }

    func testListsEveryPanelWithSidebarAndInspector() {
        let items = WindowMenu.items(layout: .standard, terminalShowing: false)
        XCTAssertEqual(items.map(\.title), ["Sidebar", "Inspector", "Pond", "Code", "Terminal"])
        XCTAssertEqual(items.first { $0.id == .panel(.code) }?.shortcut, .toggleCode)
        XCTAssertEqual(items.first { $0.id == .sidebar }?.checked, true)
    }

    func testClosingAPanelUnchecksItAndChoosingItBringsItBack() {
        var l = DockLayout.standard
        l.right.selected = .code
        XCTAssertEqual(WindowMenu.items(layout: l, terminalShowing: false).first { $0.id == .panel(.code) }?.checked, true)
        l = layout(WindowMenu.perform(.panel(.code), on: l, terminalShowing: false))
        XCTAssertTrue(l.hidden.contains(.code))
        XCTAssertEqual(WindowMenu.items(layout: l, terminalShowing: false).first { $0.id == .panel(.code) }?.checked, false)
        l = layout(WindowMenu.perform(.panel(.code), on: l, terminalShowing: false))
        XCTAssertEqual(l.zone(of: .code), .right)
        XCTAssertEqual(l.right.selected, .code)
        XCTAssertTrue(l.isShowing(.code))
    }

    func testOpensAFoldedPanelAndMovedPanelsReturnHome() {
        var l = DockLayout.standard
        l.move(.code, to: .bottom)
        l.close(.code)
        l = layout(WindowMenu.perform(.panel(.code), on: l, terminalShowing: false))
        XCTAssertEqual(l.zone(of: .code), .right)
        l.right.collapsed = true
        XCTAssertFalse(l.isShowing(.code))
        l = layout(WindowMenu.perform(.panel(.code), on: l, terminalShowing: false))
        XCTAssertFalse(l.right.collapsed)
    }

    func testTerminalAndSidebarAndInspector() {
        XCTAssertEqual(WindowMenu.perform(.panel(.terminal), on: .standard, terminalShowing: false), .toggleTerminal)
        XCTAssertEqual(WindowMenu.items(layout: .standard, terminalShowing: true).last?.checked, true)
        let s = layout(WindowMenu.perform(.sidebar, on: .standard, terminalShowing: false))
        XCTAssertTrue(s.sidebarCollapsed)
        var l = layout(WindowMenu.perform(.inspector, on: .standard, terminalShowing: false))
        XCTAssertFalse(WindowMenu.isInspectorOpen(l))
        l = layout(WindowMenu.perform(.inspector, on: l, terminalShowing: false))
        XCTAssertTrue(WindowMenu.isInspectorOpen(l))
    }

    func testResetTitle() {
        XCTAssertEqual(WindowMenu.resetTitle(workspace: "Review"), "Reset Review")
    }

    func testLayoutRoundTripKeepsSidebarAndSizes() throws {
        var l = DockLayout.standard
        l.sidebarCollapsed = true
        l.setSidebarWidth(300)
        l.setSize(420, for: .right)
        l.close(.pond)
        var w = DockWorkspaces()
        w.update(l)
        let back = try JSONDecoder().decode(DockWorkspaces.self, from: JSONEncoder().encode(w))
        XCTAssertEqual(back.active.current, l)
        XCTAssertEqual(back.active.current.sidebarWidth, 300)
    }

    func testOldLayoutWithoutSidebarDecodes() throws {
        let json = #"{"centre":{"panels":[]},"right":{"panels":["pond","code"],"selected":"pond"},"bottom":{"panels":["terminal"]},"hidden":[]}"#
        let l = try JSONDecoder().decode(DockLayout.self, from: Data(json.utf8))
        XCTAssertFalse(l.sidebarCollapsed)
        XCTAssertNil(l.sidebarWidth)
    }

    func testResetRestoresSavedAndKeepsOtherWorkspaces() {
        var w = DockWorkspaces()
        var l = w.active.current
        l.close(.code); l.sidebarCollapsed = true
        w.update(l)
        w.resetActive()
        XCTAssertEqual(w.active.current, DockLayout.standard)
    }
}
