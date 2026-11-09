import Testing
@testable import SqueakMacCore

@Suite struct PaneWidthsTests {
    @Test func clampsToRanges() {
        #expect(PaneWidths.clamp(100, PaneWidths.sidebarRange, fallback: 256) == 200)
        #expect(PaneWidths.clamp(900, PaneWidths.sidebarRange, fallback: 256) == 360)
        #expect(PaneWidths.clamp(300, PaneWidths.inspectorRange, fallback: 320) == 300)
        #expect(PaneWidths.clamp(900, PaneWidths.inspectorRange, fallback: 320) == 560)
    }

    @Test func unsetOrBrokenStoredWidthFallsBack() {
        #expect(PaneWidths.clamp(0, PaneWidths.sidebarRange, fallback: 256) == 256)
        #expect(PaneWidths.clamp(.nan, PaneWidths.inspectorRange, fallback: 320) == 320)
    }

    @Test func centreKeepsItsRoom() {
        // 960 window, sidebar 360 open: the inspector may take 960 - 360 - 420 = 180, so it holds at its minimum.
        #expect(PaneWidths.limit(range: PaneWidths.inspectorRange, window: 960, otherPane: 360) == 280)
        // 1440 window, sidebar 248: plenty.
        #expect(PaneWidths.limit(range: PaneWidths.inspectorRange, window: 1440, otherPane: 248) == 560)
        #expect(PaneWidths.effective(520, range: PaneWidths.inspectorRange, fallback: 320, window: 1100, otherPane: 300) == 380)
    }

    @Test func inspectorTakesAThirdOfTheRoomUntilDragged() {
        // 1440 window, 256 sidebar: 30% of 1184 is 355; the centre keeps the other 70%.
        #expect(PaneWidths.inspectorDefault(window: 1440, sidebar: 256) == 355)
        // Sidebar hidden: more room, so a wider inspector; a small window holds the minimum; a huge one the maximum.
        #expect(PaneWidths.inspectorDefault(window: 1440, sidebar: 0) == 432)
        #expect(PaneWidths.inspectorDefault(window: 960, sidebar: 256) == 280)
        #expect(PaneWidths.inspectorDefault(window: 3000, sidebar: 256) == 560)
        #expect(PaneWidths.inspectorDefault(window: .nan, sidebar: 256) == PaneWidths.inspectorDefault)
    }

    @Test func dragMovesFromWhereItStarted() {
        let r = PaneWidths.sidebarRange
        #expect(PaneWidths.dragged(start: 248, translation: 40, grewToward: 1, range: r, window: 1440, otherPane: 0) == 288)
        #expect(PaneWidths.dragged(start: 248, translation: -200, grewToward: 1, range: r, window: 1440, otherPane: 0) == 200)
        #expect(PaneWidths.dragged(start: 248, translation: 400, grewToward: 1, range: r, window: 1440, otherPane: 0) == 360)
        // The inspector grows when the handle moves left.
        #expect(PaneWidths.dragged(start: 320, translation: -60, grewToward: -1, range: PaneWidths.inspectorRange, window: 1440, otherPane: 248) == 380)
    }
}
