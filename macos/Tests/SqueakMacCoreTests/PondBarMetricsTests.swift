import Testing
@testable import SqueakMacCore

@Suite struct PondBarMetricsTests {
    @Test func controlsAreCentredWithAirAboveAndBelow() {
        #expect(PondBarMetrics.verticalInset >= 10)
        #expect(PondBarMetrics.verticalInset * 2 + PondBarMetrics.controlHeight == PondBarMetrics.height)
    }

    @Test func itemTabsSizeToContentWithinMinAndMax() {
        #expect(PondBarMetrics.itemTabWidth(content: 40) == 96)
        #expect(PondBarMetrics.itemTabWidth(content: 130) == 130)
        #expect(PondBarMetrics.itemTabWidth(content: 400) == 200)
    }

    @Test func duckTabsGrowToNaturalWidthUpToTheMax() {
        #expect(PondBarMetrics.duckTabWidth(natural: 240) == 240)
        #expect(PondBarMetrics.duckTabWidth(natural: 500) == 280)
    }

    @Test func tabsKeepNaturalWidthWhileTheBarHasRoom() {
        #expect(PondBarMetrics.fit(natural: [240, 120], available: 900) == [240, 120])
    }

    @Test func tabsShrinkOnlyWhenTheBarIsFull() {
        let fit = PondBarMetrics.fit(natural: [280, 200], available: 400)
        #expect(fit.reduce(0, +) + PondBarMetrics.tabGap <= 400.5)
        #expect(fit[0] < 280)
    }

    @Test func messageTextKeepsAComfortableMeasure() {
        #expect(RoomRowPlan.readingWidth >= 680 && RoomRowPlan.readingWidth <= 720)
    }
}

@Suite struct PondSurfaceMetricsTests {
    @Test func theTintFadesOutWithinAboutOneHundredTwentyPointsAndCoversBothRows() {
        #expect(PondQuietTint.fadeHeight <= 120)
        #expect(PondWash.duckFadeHeight == PondQuietTint.fadeHeight)
        #expect(PondBarMetrics.surfaceHeight == PondBarMetrics.height + PondBarMetrics.subheaderHeight)
        #expect(PondBarMetrics.surfaceHeight <= PondQuietTint.fadeHeight)
        #expect(PondBarMetrics.chatFadeHeight > 0 && PondBarMetrics.chatFadeHeight <= 40)
    }
}
