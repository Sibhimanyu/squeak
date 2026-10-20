import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct QuickLayoutTests {
    private let screens: [CGFloat] = [700, 800, 900, 1200]
    private let fields: [CGFloat] = [QuickLayout.minFieldHeight, 80, QuickLayout.maxFieldHeight]

    @Test func aHugeContextNeverPushesTheWindowPastTheScreen() {
        for screen in screens {
            for field in fields {
                let h = QuickLayout.windowHeight(natural: 50_000, screenHeight: screen, fieldHeight: field)
                #expect(h <= screen - QuickLayout.screenMargin, "screen \(screen), field \(field): \(h)")
            }
        }
    }

    @Test func aTallerFieldLeavesTheContextLessRoom() {
        let short = QuickLayout.contextLimit(screenHeight: 800, fieldHeight: QuickLayout.minFieldHeight)
        let tall = QuickLayout.contextLimit(screenHeight: 800, fieldHeight: QuickLayout.maxFieldHeight)
        #expect(tall < short)
        #expect(short - tall == QuickLayout.maxFieldHeight - QuickLayout.minFieldHeight)
    }

    @Test func aShortReplyTakesNoMoreRoomThanItsOwnHeight() {
        #expect(QuickLayout.contextShown(natural: 90, screenHeight: 1200, fieldHeight: 32) == 90)
        #expect(QuickLayout.contextShown(natural: 90, screenHeight: 700, fieldHeight: 32) == 90)
    }

    @Test func aTinyScreenKeepsAReadableFloorRatherThanCollapsing() {
        #expect(QuickLayout.contextLimit(screenHeight: 300, fieldHeight: QuickLayout.maxFieldHeight) == QuickLayout.minContext)
    }

    @Test func theFieldIsNeverCountedLargerOrSmallerThanItCanBe() {
        #expect(QuickLayout.contextLimit(screenHeight: 900, fieldHeight: 5_000) == QuickLayout.contextLimit(screenHeight: 900, fieldHeight: QuickLayout.maxFieldHeight))
        #expect(QuickLayout.contextLimit(screenHeight: 900, fieldHeight: 0) == QuickLayout.contextLimit(screenHeight: 900, fieldHeight: QuickLayout.minFieldHeight))
    }
}
