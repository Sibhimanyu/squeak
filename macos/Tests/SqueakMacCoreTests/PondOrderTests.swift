import Testing

@testable import SqueakMacCore

@Suite struct PondOrderTests {
    @Test func recentKeepsTheCallersOrder() {
        let s = PondOrderState(mode: .recent, order: ["c", "b", "a"])
        #expect(PondOrder.apply(keys: ["a", "b", "c"], state: s) == ["a", "b", "c"])
    }

    @Test func manualListsSavedFirstAndNewPondsOnTopNewestFirst() {
        let s = PondOrderState(mode: .manual, order: ["c", "gone", "a", "c"])
        #expect(PondOrder.apply(keys: ["n2", "a", "n1", "b", "c"], state: s) == ["n2", "n1", "b", "c", "a"])
    }

    @Test func manualWithNothingSavedIsTheCallersOrder() {
        #expect(PondOrder.apply(keys: ["a", "b"], state: PondOrderState(mode: .manual)) == ["a", "b"])
    }

    @Test func hiddenAndLabelFilteringStillApplyAfterOrdering() {
        let s = PondOrderState(mode: .manual, order: ["c", "b", "a"])
        let names = PondOrder.apply(keys: ["a", "b", "c"], state: s)
        let entries = names.map { PondFilter.Entry(name: $0, hidden: $0 == "b", labels: $0 == "c" ? [] : ["x"]) }
        #expect(PondFilter.apply(entries, label: nil, showHidden: false).names == ["c", "a"])
        #expect(PondFilter.apply(entries, label: "x", showHidden: true).names == ["b", "a"])
    }

    @Test func movingBeforeAPondAndToTheEnd() {
        #expect(PondOrder.moved(all: ["a", "b", "c"], shown: ["a", "b", "c"], moving: "c", before: "a") == ["c", "a", "b"])
        #expect(PondOrder.moved(all: ["a", "b", "c"], shown: ["a", "b", "c"], moving: "a", before: nil) == ["b", "c", "a"])
        #expect(PondOrder.moved(all: ["a", "b", "c"], shown: ["a", "b", "c"], moving: "b", before: "b") == ["a", "b", "c"])
    }

    @Test func steppingOneUpOrDown() {
        let a = ["a", "b", "c"]
        #expect(PondOrder.stepped(all: a, shown: a, moving: "b", by: -1) == ["b", "a", "c"])
        #expect(PondOrder.stepped(all: a, shown: a, moving: "b", by: 1) == ["a", "c", "b"])
        #expect(PondOrder.stepped(all: a, shown: a, moving: "a", by: -1) == nil)
        #expect(PondOrder.stepped(all: a, shown: a, moving: "c", by: 1) == nil)
        #expect(PondOrder.stepped(all: a, shown: ["a", "c"], moving: "x", by: 1) == nil)
    }

    @Test func aHiddenPondKeepsItsPlaceBesideItsNeighbour() {
        // b is hidden: moving a to the end of what is shown lands after c, b stays where it was.
        #expect(PondOrder.moved(all: ["a", "b", "c"], shown: ["a", "c"], moving: "a", before: nil) == ["b", "c", "a"])
    }
}
