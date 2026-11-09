import Testing
@testable import SqueakMacCore

@Suite struct TurnExpansionTests {
    @Test func turnButtonFlipsOnlyThisTurn() {
        var a = TurnExpansion(), b = TurnExpansion()
        a.toggleTurn()
        #expect(a.open && a.version == 1)
        #expect(!b.open && b.version == 0)
        b.applyGlobal(generation: 0, allOpen: false)
        #expect(b.version == 0)
    }

    @Test func globalSetsEveryTurnThenButtonFlipsBack() {
        var a = TurnExpansion(), b = TurnExpansion()
        a.toggleTurn()
        a.applyGlobal(generation: 1, allOpen: true)
        b.applyGlobal(generation: 1, allOpen: true)
        #expect(a.open && b.open)
        a.toggleTurn()
        #expect(!a.open && b.open)
        a.applyGlobal(generation: 2, allOpen: false)
        b.applyGlobal(generation: 2, allOpen: false)
        #expect(!a.open && !b.open)
    }

    @Test func repeatedGenerationIsIgnored() {
        var a = TurnExpansion()
        a.applyGlobal(generation: 1, allOpen: true)
        a.toggleTurn()
        a.applyGlobal(generation: 1, allOpen: true)
        #expect(!a.open)
    }
}
