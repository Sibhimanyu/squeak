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
}
