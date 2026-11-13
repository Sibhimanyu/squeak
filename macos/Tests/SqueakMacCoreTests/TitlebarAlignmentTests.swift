import Testing
@testable import SqueakMacCore

@Suite struct TitlebarAlignmentTests {
    @Test func buttonsHigherThanTheRowMoveDown() {
        #expect(TitlebarAlignment.downShift(buttonMidFromTop: 14, rowHeight: 44) == 8)
    }
    @Test func alignedNeedsNoMove() {
        let s = TitlebarAlignment.downShift(buttonMidFromTop: 22, rowHeight: 44)
        #expect(s == 0 && !TitlebarAlignment.shouldMove(s))
    }
    @Test func rowInsetIsTheInverse() {
        #expect(TitlebarAlignment.rowTopInset(buttonMidFromTop: 14, rowHeight: 44) == -8)
        #expect(TitlebarAlignment.rowTopInset(buttonMidFromTop: 30, rowHeight: 44) == 8)
    }
    @Test func tinyOrNonFiniteShiftsAreIgnored() {
        #expect(!TitlebarAlignment.shouldMove(0.1))
        #expect(!TitlebarAlignment.shouldMove(.nan))
        #expect(TitlebarAlignment.shouldMove(-3))
    }

    @Test func windowedButtonsShareFullScreensColumnAndTheRowsCentreLine() {
        let o0 = TitlebarAlignment.windowedButtonOrigin(index: 0, buttonWidth: 14, buttonHeight: 16, windowHeight: 800, rowHeight: 44)
        let o1 = TitlebarAlignment.windowedButtonOrigin(index: 1, buttonWidth: 14, buttonHeight: 16, windowHeight: 800, rowHeight: 44)
        let o2 = TitlebarAlignment.windowedButtonOrigin(index: 2, buttonWidth: 14, buttonHeight: 16, windowHeight: 800, rowHeight: 44)
        // the 12pt circle's left edge is at full screen's x
        #expect(o0.x + 1 == FullScreenLights.lightX(0))
        #expect(o1.x - o0.x == 20 && o2.x - o1.x == 20)
        // centre is 22pt below the top: 800 - 22
        #expect(o0.y + 8 == 778)
        #expect(o0.y == o1.y && o1.y == o2.y)
        // independent of window height: same distance from the top
        let t = TitlebarAlignment.windowedButtonOrigin(index: 0, buttonWidth: 14, buttonHeight: 16, windowHeight: 500, rowHeight: 44)
        #expect(t.y + 8 == 478)
    }
}

