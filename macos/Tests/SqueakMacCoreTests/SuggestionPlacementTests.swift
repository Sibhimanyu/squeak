import CoreGraphics
import Testing
@testable import SqueakMacCore

@Suite struct SuggestionPlacementTests {
    @Test func opensUpwardWhenItFitsAbove() {
        let p = SuggestionPlacement.resolve(spaceAbove: 600, spaceBelow: 40, contentHeight: 250)
        #expect(p.direction == .up)
        #expect(p.maxHeight == 250)
    }

    @Test func composerAtTheBottomNeverOpensDownward() {
        let p = SuggestionPlacement.resolve(spaceAbove: 300, spaceBelow: 20, contentHeight: 400)
        #expect(p.direction == .up)
        let expected: CGFloat = 286
        #expect(p.maxHeight == expected)
    }

    @Test func opensDownWhenOnlyBelowHoldsIt() {
        let p = SuggestionPlacement.resolve(spaceAbove: 50, spaceBelow: 500, contentHeight: 200)
        #expect(p.direction == .down)
        #expect(p.maxHeight == 200)
    }

    @Test func noSpaceAtAllIsZeroNotNegative() {
        let p = SuggestionPlacement.resolve(spaceAbove: 0, spaceBelow: 0, contentHeight: 100)
        #expect(p.maxHeight == 0)
    }

    @Test func bestMatchSitsNearestTheComposer() {
        #expect(SuggestionPlacement.drawOrder(count: 3, direction: .up) == [2, 1, 0])
        #expect(SuggestionPlacement.drawOrder(count: 3, direction: .down) == [0, 1, 2])
    }

    @Test func arrowsMoveNaturallyOnScreen() {
        #expect(SuggestionPlacement.step(up: true, direction: .up) == 1)
        #expect(SuggestionPlacement.step(up: false, direction: .up) == -1)
        #expect(SuggestionPlacement.step(up: true, direction: .down) == -1)
        #expect(SuggestionPlacement.step(up: false, direction: .down) == 1)
    }

    @Test func listStartsAtTheTriggerCharacter() {
        #expect(SuggestionPlacement.originX(triggerX: 90, anchorWidth: 700, popupWidth: 320) == 90)
    }

    @Test func listIsClampedInsideTheComposer() {
        #expect(SuggestionPlacement.originX(triggerX: -12, anchorWidth: 700, popupWidth: 320) == 0)
        #expect(SuggestionPlacement.originX(triggerX: 650, anchorWidth: 700, popupWidth: 320) == 380)
        #expect(SuggestionPlacement.originX(triggerX: 50, anchorWidth: 200, popupWidth: 200) == 0)
        #expect(SuggestionPlacement.originX(triggerX: nil, anchorWidth: 700, popupWidth: 320) == 0)
    }

    @Test func listSitsAboveTheFieldNotOnIt() {
        let gap = SuggestionPlacement.gap
        #expect(SuggestionPlacement.originY(direction: .up, anchorHeight: 90, popupHeight: 120) == -(120 + gap))
        #expect(SuggestionPlacement.originY(direction: .down, anchorHeight: 90, popupHeight: 120) == 90 + gap)
        let p = SuggestionPlacement.origin(direction: .up, triggerX: 40, anchorSize: CGSize(width: 600, height: 90), popupSize: CGSize(width: 320, height: 100))
        // bottom edge (origin + height) is `gap` above the field's top border at y = 0
        #expect(p.y + 100 == -gap)
        #expect(p.x == 40)
    }

    @Test func widthIsCompactAndFitsANarrowComposer() {
        #expect(SuggestionPlacement.width(anchorWidth: 900) == 320)
        #expect(SuggestionPlacement.width(anchorWidth: 240) == 240)
    }

    @Test func listShowsSixRowsThenScrolls() {
        let cap = SuggestionPlacement.heightCap(rowHeight: 28, padding: 8)
        #expect(cap == 176)
        let p = SuggestionPlacement.resolve(spaceAbove: 900, spaceBelow: 0, contentHeight: 8 * 28 + 8, cap: cap)
        #expect(p.maxHeight == 176)
        let small = SuggestionPlacement.resolve(spaceAbove: 900, spaceBelow: 0, contentHeight: 2 * 28 + 8, cap: cap)
        #expect(small.maxHeight == 64)
    }
}
