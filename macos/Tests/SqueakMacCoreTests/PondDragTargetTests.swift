import Testing
@testable import SqueakMacCore

@Suite struct PondDragTargetTests {
    let shown = ["a", "b", "c"]

    @Test func edgeDecidesBeforeOrAfter() {
        #expect(PondDragTarget.slot(rowIndex: 1, y: 5, rowHeight: 30) == 1)
        #expect(PondDragTarget.slot(rowIndex: 1, y: 25, rowHeight: 30) == 2)
        #expect(PondDragTarget.slot(rowIndex: 1, y: 15, rowHeight: 30) == 1)
    }

    @Test func slotMapsToBeforeKey() {
        #expect(PondDragTarget.before(slot: 0, shown: shown) == "a")
        #expect(PondDragTarget.before(slot: 2, shown: shown) == "c")
        #expect(PondDragTarget.before(slot: 3, shown: shown) == nil)
    }

    @Test func noGapWhereNothingMoves() {
        #expect(PondDragTarget.gap(slot: 1, moving: "b", shown: shown) == nil)
        #expect(PondDragTarget.gap(slot: 2, moving: "b", shown: shown) == nil)
        #expect(PondDragTarget.gap(slot: 0, moving: "b", shown: shown) == 0)
        #expect(PondDragTarget.gap(slot: 3, moving: "b", shown: shown) == 3)
    }
}
