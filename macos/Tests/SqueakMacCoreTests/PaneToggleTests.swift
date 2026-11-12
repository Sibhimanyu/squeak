import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct PaneToggleTests {
    @Test func edgesFollowThePane() {
        #expect(PaneToggle.anchor(.left, open: true) == .sidebarBar)
        #expect(PaneToggle.anchor(.left, open: false) == .centreLeading)
        #expect(PaneToggle.anchor(.right, open: true) == .inspectorBar)
        #expect(PaneToggle.anchor(.right, open: false) == .centreTrailing)
    }

    @Test func leftToggleFollowsSidebarWidthAndClearsTrafficLightsWhenClosed() {
        for width in [200.0, 256, 360] {
            #expect(PaneToggle.x(.left, open: true, window: 1440, inspectorWidth: 400, sidebarWidth: width) == width - 40)
            #expect(PaneToggle.x(.left, open: false, window: 1440, inspectorWidth: 400, sidebarWidth: width) == 82)
        }
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

struct FullScreenLayoutTests {
    @Test func fullScreenKeepsTheTrafficLightClearance() {
        #expect(PaneToggle.clearance(fullScreen: false) == PaneToggle.trafficLights)
        #expect(PaneToggle.clearance(fullScreen: true) == PaneToggle.trafficLights)
        #expect(PaneToggle.x(.left, open: true, window: 1200, inspectorWidth: 300, fullScreen: true, sidebarWidth: 256) == 216)
        #expect(PaneToggle.x(.left, open: false, window: 1200, inspectorWidth: 300, fullScreen: true) == PaneToggle.trafficLights + PaneToggle.barPadding)
        #expect(PaneToggle.x(.left, open: false, window: 1200, inspectorWidth: 300) == PaneToggle.trafficLights + PaneToggle.barPadding)
        // The right toggle does not depend on the lights.
        #expect(PaneToggle.x(.right, open: false, window: 1200, inspectorWidth: 300, fullScreen: true)
                == PaneToggle.x(.right, open: false, window: 1200, inspectorWidth: 300))
    }

    @Test func aFullScreenWindowKeepsTheAppRegularEvenWhenItReadsAsNotVisible() {
        #expect(ActivationRules.wantsRegular(hasWindow: false, showRequestedAt: nil, lastCloseAt: nil, now: Date(), fullScreenWindows: 1))
        #expect(!ActivationRules.wantsRegular(hasWindow: false, showRequestedAt: nil, lastCloseAt: nil, now: Date()))
    }

    @Test func fullScreenIsInTheRegistry() {
        #expect(ShortcutRegistry.keycap(.fullScreen) == "⌃⌘F")
    }
}
