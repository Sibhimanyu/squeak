import CoreGraphics
import Testing
@testable import SqueakMarkup

@Suite("Inline chip")
struct InlineChipTests {
    @Test func classifiesAResolvedPathApartFromCode() {
        #expect(InlineChip.kind(isLinkedPath: true) == .path)
        #expect(InlineChip.kind(isLinkedPath: false) == .code)
    }

    @Test func hangsOnTheBaselineWithPaddingAndStaysInsideTheContainer() {
        let f = InlineChip.Fragment(x: 0, width: 200, baselineY: 15, containerWidth: 100)
        let r = InlineChip.rects(fragments: [f], ascender: 10, descender: -3)
        #expect(r[0].minX == 0 && r[0].maxX == 100)
        #expect(r[0].minY == 15 - 10 - 1 && r[0].height == 13 + 2)
    }

    @Test func onlyTheFirstLineGetsLeadingPadding() {
        let a = InlineChip.Fragment(x: 20, width: 60, baselineY: 15, containerWidth: 300)
        let b = InlineChip.Fragment(x: 0, width: 40, baselineY: 37, containerWidth: 300)
        let r = InlineChip.rects(fragments: [a, b], ascender: 10, descender: -3)
        #expect(r[0].minX == 20 - InlineChip.horizontalPadding)
        #expect(r[1].minX == 0 && r[1].width == 40)
    }
}
