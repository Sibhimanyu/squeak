import Testing
@testable import SqueakMacCore

@Suite struct PaneToggleTests {
    @Test func edgesFollowThePane() {
        #expect(PaneToggle.anchor(.left, open: true) == .sidebarBar)
        #expect(PaneToggle.anchor(.left, open: false) == .centreLeading)
        #expect(PaneToggle.anchor(.right, open: true) == .inspectorBar)
        #expect(PaneToggle.anchor(.right, open: false) == .centreTrailing)
    }

    @Test func leftToggleNeverMovesSideways() {
        let a = PaneToggle.x(.left, open: true, window: 1440, inspectorWidth: 400)
        #expect(a == PaneToggle.x(.left, open: false, window: 1440, inspectorWidth: 400))
        #expect(a == 82)
    }

    @Test func rightToggleRidesTheInspectorEdge() {
        #expect(PaneToggle.x(.right, open: true, window: 1440, inspectorWidth: 400) == 1052)
        #expect(PaneToggle.x(.right, open: false, window: 1440, inspectorWidth: 400) == 1400)
    }

    @Test func headersReserveRoomOnlyWhileClosed() {
        #expect(PaneToggle.reserve(.left, open: true) == 0)
        #expect(PaneToggle.reserve(.right, open: false) == 28)
    }

    @Test func labelsAndShortcuts() {
        #expect(PaneToggle.label(.left, open: true) == "Hide sidebar")
        #expect(PaneToggle.label(.left, open: false) == "Show sidebar")
        #expect(PaneToggle.help(.left, open: true) == "Hide sidebar (⌘B)")
        #expect(PaneToggle.help(.right, open: false) == "Show inspector (⌥⌘B)")
    }

    @Test func shortcutMapHasBothToggles() {
        func chords(_ id: ShortcutID) -> [String] { ShortcutRegistry.all.first { $0.id == id }!.chords.map(\.display) }
        #expect(chords(.toggleSidebar).contains("⌘B"))
        #expect(chords(.toggleInspector) == ["⌥⌘B"])
        #expect(chords(.zenMode) == ["⇧⌘."])
    }
}
