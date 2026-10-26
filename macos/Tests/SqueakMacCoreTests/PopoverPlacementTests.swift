import CoreGraphics
import Testing
@testable import SqueakMacCore

@Suite struct PopoverPlacementTests {
    let visible = CGRect(x: 0, y: 0, width: 1440, height: 875)
    let size = CGSize(width: 360, height: 400)

    @Test func centresUnderTheButtonBelowTheMenuBar() {
        let button = CGRect(x: 1000, y: 875, width: 40, height: 24)
        let f = PopoverPlacement.frame(button: button, size: size, visible: visible)
        #expect(f.midX == button.midX)
        #expect(f.maxY == 875 - PopoverPlacement.gap)
        #expect(f.size == size)
    }

    @Test func staysInsideTheRightEdge() {
        let button = CGRect(x: 1410, y: 875, width: 30, height: 24)
        let f = PopoverPlacement.frame(button: button, size: size, visible: visible)
        #expect(f.maxX == visible.maxX - PopoverPlacement.edgeMargin)
    }

    @Test func staysInsideTheLeftEdge() {
        let f = PopoverPlacement.frame(button: CGRect(x: 0, y: 875, width: 30, height: 24), size: size, visible: visible)
        #expect(f.minX == PopoverPlacement.edgeMargin)
    }

    @Test func shrinksToAShortScreen() {
        let short = CGRect(x: 0, y: 0, width: 1440, height: 300)
        let f = PopoverPlacement.frame(button: CGRect(x: 700, y: 300, width: 30, height: 24), size: size, visible: short)
        #expect(f.minY == short.minY + PopoverPlacement.edgeMargin)
        #expect(f.maxY == 300 - PopoverPlacement.gap)
    }

    @Test func followsASecondScreenToTheLeft() {
        let left = CGRect(x: -1920, y: 0, width: 1920, height: 1055)
        let f = PopoverPlacement.frame(button: CGRect(x: -100, y: 1055, width: 30, height: 24), size: size, visible: left)
        #expect(f.maxX <= left.maxX - PopoverPlacement.edgeMargin)
        #expect(f.minX >= left.minX)
    }
}
