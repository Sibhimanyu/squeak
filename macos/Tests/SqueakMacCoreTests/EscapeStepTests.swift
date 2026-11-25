import Testing

@testable import SqueakMacCore

@Suite struct EscapeStepTests {
    private func step(
        new: Bool = true, overlay: Bool = false, pane: Bool = false, pinned: Bool = false, page: EscapeRule.Page, running: Bool = false
    ) -> EscapeStep {
        EscapeRule.step(isNewLayout: new, overlayOpen: overlay, paneOpen: pane, panePinned: pinned, page: page, turnRunning: running)
    }

    @Test func overlaysComeFirst() {
        #expect(step(overlay: true, pane: true, page: .duckChat) == .nothing)
    }

    @Test func anUnpinnedPaneClosesBeforeAnyPageChange() {
        for page in [EscapeRule.Page.duckChat, .room, .dashboard] { #expect(step(pane: true, page: page) == .closePane) }
    }

    @Test func aPinnedPaneIsLeftAlone() {
        #expect(step(pane: true, pinned: true, page: .duckChat) == .toRoom)
        #expect(step(pane: true, pinned: true, page: .room) == .toDashboard)
    }

    @Test func stepsBackDuckThenRoomThenStops() {
        #expect(step(page: .duckChat) == .toRoom)
        #expect(step(page: .room) == .toDashboard)
        #expect(step(page: .dashboard) == .nothing)
        #expect(step(page: .other) == .nothing)
    }

    @Test func aRunningTurnDoesNotChangeIt() {
        #expect(step(page: .duckChat, running: true) == .toRoom)
    }

    @Test func classicLayoutOnlySwallows() {
        #expect(step(new: false, pane: true, page: .duckChat) == .nothing)
        #expect(step(new: false, page: .room) == .nothing)
    }
}
