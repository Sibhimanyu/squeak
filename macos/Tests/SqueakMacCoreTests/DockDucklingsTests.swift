import Testing
@testable import SqueakMacCore

@Suite struct DockDucklingsTests {
    let session = SessionKey(provider: "native", hostSessionId: "s1")
    func ref(_ id: String) -> DucklingRef { DucklingRef(session: session, taskId: id) }

    @Test func opensSelectsAndIsUnique() {
        var d = DockDucklings()
        let first = d.open(ref("a")); let second = d.open(ref("b"))
        #expect(first == .right && second == .right)
        #expect(d.selected[.right] == ref("b"))
        let again = d.open(ref("a"), in: .bottom)
        #expect(again == .right)   // already open: selected where it is, not duplicated
        #expect(d.selected[.right] == ref("a"))
        #expect(d.ducklings(in: .right).count == 2)
        #expect(d.ducklings(in: .bottom).isEmpty)
    }

    @Test func closeRestoresWhatTheZoneShowed() {
        var d = DockDucklings()
        d.open(ref("a"), showing: .panel(.code))
        d.open(ref("b"), showing: .panel(.pond))   // a duckling already covers the zone: memory stays Code
        let closedB = d.close(ref("b"))
        #expect(closedB == nil)           // another duckling takes over
        #expect(d.selected[.right] == ref("a"))
        let closedA = d.close(ref("a"))
        #expect(closedA == .panel(.code))
        #expect(!d.has(in: .right))
    }

    @Test func centreIsRefusedAndClosesOnMove() {
        var d = DockDucklings()
        let refused = d.open(ref("a"), in: .centre)
        #expect(refused == nil)
        d.open(ref("a"))
        let moved = d.move(ref("a"), to: .centre)
        #expect(moved)
        #expect(!d.isOpen(ref("a")))
    }

    @Test func movesBetweenStripsAndReorders() {
        var d = DockDucklings()
        d.open(ref("a")); d.open(ref("b"))
        d.move(ref("b"), to: .right, before: ref("a"))
        #expect(d.ducklings(in: .right) == [ref("b"), ref("a")])
        d.move(ref("a"), to: .bottom)
        #expect(d.zone(of: ref("a")) == .bottom)
        #expect(d.selected[.bottom] == ref("a"))
        #expect(d.ducklings(in: .right) == [ref("b")])
    }

    @Test func prunedKeepsOnlyItsChat() {
        var d = DockDucklings()
        d.open(ref("a"))
        let other = SessionKey(provider: "native", hostSessionId: "s2")
        d.open(DucklingRef(session: other, taskId: "x"))
        let p = d.pruned(keeping: [session])
        #expect(p.ducklings(in: .right) == [ref("a")])
        #expect(p.selected[.right] == nil || p.selected[.right] == ref("a"))
    }

    @Test func dragMatrixAndPayload() {
        let item = DockItem.duckling(ref("a"))
        #expect(DragScope.allows(item, on: .rightStrip))
        #expect(DragScope.allows(item, on: .bottomStrip))
        #expect(!DragScope.allows(item, on: .centreStrip))
        #expect(!DragScope.allows(item, on: .edgeStrip(.centre)))
        #expect(DragScope.allows(item, on: .edgeStrip(.right)))
        #expect(!DragScope.allows(item, on: .pondList))
        #expect(DockItemPayload.decode(DockItemPayload.encode(item)) == item)
    }
}
