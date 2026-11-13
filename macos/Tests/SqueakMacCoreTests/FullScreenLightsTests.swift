import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct FullScreenLightsTests {
    let t0 = Date(timeIntervalSince1970: 1000)

    @Test func layoutOffsets() {
        #expect(FullScreenLights.clearance(fullScreen: false, revealed: true) == PaneToggle.trafficLights)
        #expect(FullScreenLights.clearance(fullScreen: true, revealed: false) == 0)
        #expect(FullScreenLights.clearance(fullScreen: true, revealed: true) == PaneToggle.trafficLights)
        #expect(FullScreenLights.width == 52)
    }

    @Test func revealsAtTopBandOnly() {
        var r = FullScreenReveal()
        let v1 = r.update(now: t0, fromTop: 30, menuBarHeight: 24, overControls: false)
        #expect(v1 == false)
        let v2 = r.update(now: t0, fromTop: 24, menuBarHeight: 24, overControls: false)
        #expect(v2 == false)
        let v3 = r.update(now: t0, fromTop: 3, menuBarHeight: 24, overControls: false)
        #expect(v3 == true)
    }

    @Test func staysWhileInMenuBarOrOverControls() {
        var r = FullScreenReveal()
        r.update(now: t0, fromTop: 0, menuBarHeight: 24, overControls: false)
        let v4 = r.update(now: t0 + 5, fromTop: 20, menuBarHeight: 24, overControls: false)
        #expect(v4)
        let v5 = r.update(now: t0 + 10, fromTop: 40, menuBarHeight: 24, overControls: true)
        #expect(v5)
        let v6 = r.update(now: t0 + 10.5, fromTop: 40, menuBarHeight: 24, overControls: true)
        #expect(v6)
    }

    @Test func hidesSixTenthsAfterLeaving() {
        var r = FullScreenReveal()
        r.update(now: t0, fromTop: 0, menuBarHeight: 24, overControls: false)
        let v7 = r.update(now: t0 + 0.3, fromTop: 200, menuBarHeight: 24, overControls: false)
        #expect(v7)   // first look outside
        let v8 = r.update(now: t0 + 0.5, fromTop: 200, menuBarHeight: 24, overControls: false)
        #expect(v8)
        let v9 = r.update(now: t0 + 0.7, fromTop: 200, menuBarHeight: 24, overControls: false)
        #expect(v9 == false)
    }

    @Test func returningCancelsTheHide() {
        var r = FullScreenReveal()
        r.update(now: t0, fromTop: 0, menuBarHeight: 24, overControls: false)
        r.update(now: t0 + 0.4, fromTop: 200, menuBarHeight: 24, overControls: false)
        let v10 = r.update(now: t0 + 0.5, fromTop: 2, menuBarHeight: 24, overControls: false)
        #expect(v10)
        let v11 = r.update(now: t0 + 1.0, fromTop: 200, menuBarHeight: 24, overControls: false)
        #expect(v11)
    }

    @Test func resetHidesAtOnce() {
        var r = FullScreenReveal()
        r.update(now: t0, fromTop: 0, menuBarHeight: 24, overControls: false)
        r.reset()
        #expect(r.revealed == false)
    }
}

@Suite struct FullScreenLightsLayoutTests {
    @Test func controlsNeverStartOffScreenWhenRevealed() {
        #expect(FullScreenLights.groupX(revealed: true) >= 0)
        #expect(FullScreenLights.lightX(0) == 20)
    }

    @Test func twentyPointPitchOfTwelvePointCircles() {
        #expect(FullScreenLights.lightX(1) - FullScreenLights.lightX(0) == 20)
        #expect(FullScreenLights.lightX(2) - FullScreenLights.lightX(1) == 20)
        #expect(FullScreenLights.diameter == 12)
        #expect(FullScreenLights.gap == 8)
    }

    @Test func hiddenGroupIsFullyOffScreen() {
        #expect(FullScreenLights.groupX(revealed: false) + FullScreenLights.trailingEdge <= 0)
    }

    @Test func revealedArrowsSitWhereTheWindowPutsThem() {
        let windowed = FullScreenLights.clearance(fullScreen: false, revealed: false)
        #expect(FullScreenLights.clearance(fullScreen: true, revealed: true) == windowed)
        #expect(FullScreenLights.clearance(fullScreen: true, revealed: false) == 0)
        // The controls end before the first arrow (at clearance + bar padding), never on it.
        #expect(FullScreenLights.trailingEdge <= windowed + PaneToggle.barPadding)
        // The sidebar-hidden toggle takes the same offset, so it matches too.
        #expect(PaneToggle.x(.left, open: false, window: 900, inspectorWidth: 0, fullScreen: true, lightsRevealed: true)
            == PaneToggle.x(.left, open: false, window: 900, inspectorWidth: 0))
    }

    @Test func controlsAreCentredOnTheRow() {
        #expect(FullScreenLights.lightY(rowHeight: 44) + FullScreenLights.diameter / 2 == 22)
    }
}

@Suite struct FullScreenStripTests {
    @Test func staysRevealedAcrossTheWholeTopStripAfterMenuBarHides() {
        var r = FullScreenReveal()
        let t = Date(timeIntervalSince1970: 1000)
        r.update(now: t, fromTop: 0, menuBarHeight: 24, stripHeight: 44, overControls: false)
        let inStrip = r.update(now: t.addingTimeInterval(2), fromTop: 40, menuBarHeight: 24, stripHeight: 44, overControls: false)
        #expect(inStrip)
        r.update(now: t.addingTimeInterval(3), fromTop: 200, menuBarHeight: 24, stripHeight: 44, overControls: false)
        let below = r.update(now: t.addingTimeInterval(4), fromTop: 200, menuBarHeight: 24, stripHeight: 44, overControls: false)
        #expect(!below)
    }
}
