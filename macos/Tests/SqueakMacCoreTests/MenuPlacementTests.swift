import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Menu attachment")
struct MenuPlacementTests {
    private let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
    private let menu = CGSize(width: 284, height: 180)

    @Test func aDropdownStaysImmediatelyBelowItsControl() {
        let trigger = CGRect(x: 158, y: 741, width: 240, height: 40)
        let frame = MenuPlacement.frame(anchor: trigger, menu: menu, visibleFrame: screen)
        #expect(frame.minX == trigger.minX)
        #expect(trigger.minY - frame.maxY == MenuPlacement.gap)
    }

    @Test func aBottomControlOpensAboveInsteadOfCoveringItsTrigger() {
        let trigger = CGRect(x: 100, y: 20, width: 120, height: 28)
        let frame = MenuPlacement.frame(anchor: trigger, menu: menu, visibleFrame: screen)
        #expect(frame.minY - trigger.maxY == MenuPlacement.gap)
        #expect(!frame.intersects(trigger))
        #expect(screen.contains(frame))
    }

    @Test func aRightEdgeDropdownAlignsToItsControlsTrailingEdge() {
        let trigger = CGRect(x: 1320, y: 700, width: 100, height: 28)
        let frame = MenuPlacement.frame(anchor: trigger, menu: menu, visibleFrame: screen)
        #expect(frame.maxX == trigger.maxX)
        #expect(trigger.minY - frame.maxY == MenuPlacement.gap)
    }

    @Test func submenusFlipBesideTheirParentAtTheRightEdge() {
        let trigger = CGRect(x: 1300, y: 700, width: 120, height: 32)
        let frame = MenuPlacement.frame(anchor: trigger, menu: menu, visibleFrame: screen, submenu: true)
        #expect(trigger.minX - frame.maxX == MenuPlacement.gap)
        #expect(frame.maxY == trigger.maxY)
    }

    @Test func contextMenusKeepTheirClickPointOnASecondDisplay() {
        let display = CGRect(x: -1440, y: -100, width: 1440, height: 900)
        let trigger = CGRect(x: -1200, y: 500, width: 240, height: 40)
        let frame = MenuPlacement.frame(anchor: trigger, menu: menu, visibleFrame: display,
                                        contextPoint: CGPoint(x: 0.5, y: 0.25))
        #expect(frame.minX == -1080)
        #expect(frame.maxY == 530)
        #expect(display.contains(frame))
    }

    @Test func changingMenuHeightKeepsItsTopAttachedToTheSameControl() {
        let trigger = CGRect(x: 158, y: 741, width: 240, height: 40)
        for height: CGFloat in [104, 444, 180, 444] {
            let frame = MenuPlacement.frame(anchor: trigger, menu: CGSize(width: 284, height: height), visibleFrame: screen)
            #expect(frame.height == height)
            #expect(trigger.minY - frame.maxY == MenuPlacement.gap)
            #expect(frame.minX == trigger.minX)
        }
    }

    @Test func growingMenuFlipsAboveWhileShrinkingReattachesBelow() {
        let trigger = CGRect(x: 158, y: 220, width: 240, height: 28)
        let tall = MenuPlacement.frame(anchor: trigger, menu: CGSize(width: 284, height: 444), visibleFrame: screen)
        #expect(tall.minY - trigger.maxY == MenuPlacement.gap)
        let short = MenuPlacement.frame(anchor: trigger, menu: CGSize(width: 284, height: 104), visibleFrame: screen)
        #expect(trigger.minY - short.maxY == MenuPlacement.gap)
    }

}
