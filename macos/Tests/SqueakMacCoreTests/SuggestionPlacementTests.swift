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
}
