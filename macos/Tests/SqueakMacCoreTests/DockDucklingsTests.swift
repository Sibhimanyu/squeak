import Testing
@testable import SqueakMacCore

@Suite struct DockDucklingsTests {
    let session = SessionKey(provider: "native", hostSessionId: "s1")
    func ref(_ id: String) -> DucklingRef { DucklingRef(session: session, taskId: id) }

    @Test func opensSelectsAndIsUnique() {
        var d = DockDucklings()
        let first = d.open(ref("a"), in: .right); let second = d.open(ref("b"), in: .right)
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
        d.open(ref("a"), in: .right, showing: .panel(.code))
        d.open(ref("b"), in: .right, showing: .panel(.pond))   // a duckling already covers the zone: memory stays Code
        let closedB = d.close(ref("b"))
        #expect(closedB == nil)           // another duckling takes over
        #expect(d.selected[.right] == ref("a"))
        let closedA = d.close(ref("a"))
        #expect(closedA == .panel(.code))
        #expect(!d.has(in: .right))
    }

    @Test func opensInTheCentreByDefaultAndClosesWithoutMemory() {
        var d = DockDucklings()
        #expect(d.open(ref("a"), showing: .panel(.code)) == .centre)
        #expect(d.selected[.centre] == ref("a"))
        #expect(d.zone(of: ref("a")) == .centre)
        #expect(d.open(ref("a")) == .centre)   // opening an open one selects it
        #expect(d.ducklings(in: .centre) == [ref("a")])
        #expect(d.close(ref("a")) == nil)       // the store returns to the parent thread
        #expect(!d.has(in: .centre))
    }

    @Test func movesFromTheCentreToASideStripAndBack() {
        var d = DockDucklings()
        d.open(ref("a"))
        let toRight = d.move(ref("a"), to: .right); #expect(toRight)
        #expect(d.zone(of: ref("a")) == .right && !d.has(in: .centre))
        let home = d.move(ref("a"), to: .centre); #expect(home)
        #expect(d.zone(of: ref("a")) == .centre)
    }

    @Test func centreOrderPutsDucklingsAfterTheirParent() {
        let other = SessionKey(provider: "native", hostSessionId: "s2")
        let orphan = DucklingRef(session: SessionKey(provider: "native", hostSessionId: "gone"), taskId: "z")
        let s1 = session.stringValue, s2 = other.stringValue
        let items = [s1, "file", s2]
        let ducks = [DucklingRef(session: other, taskId: "x"), ref("a"), ref("b"), orphan]
        let out = CentreStripOrder.order(items, chatKey: { $0 == s1 || $0 == s2 ? $0 : nil }, ducklings: ducks)
        let names: [String] = out.map {
            switch $0 {
            case .item(let i): i
            case .duckling(let r): "d:\(r.taskId)"
            }
        }
        #expect(names == [s1, "d:a", "d:b", "file", s2, "d:x", "d:z"])
    }

    @Test func fourTabsInA330ZoneShrinkThenScroll() {
        let naturals = [60.0, 60, 80, 240].map { ChatTabWidth.chrome + $0 }
        let available = 330.0 - 40 - 36
        let cap = ChatTabWidth.cap(naturals: naturals, available: available)
        #expect(cap.isFinite && cap >= ChatTabWidth.minWidth)
        // They cannot all fit at the floor (4 x 98 > 254): the cap is the floor and the strip scrolls.
        #expect(4 * ChatTabWidth.minWidth > available)
        #expect(cap == ChatTabWidth.minWidth)
        #expect(!TabStripFit.showsAccessory(strip: 330, tabs: 4, leading: 40, accessory: 100))
    }

    @Test func movesBetweenStripsAndReorders() {
        var d = DockDucklings()
        d.open(ref("a"), in: .right); d.open(ref("b"), in: .right)
        d.move(ref("b"), to: .right, before: ref("a"))
        #expect(d.ducklings(in: .right) == [ref("b"), ref("a")])
        d.move(ref("a"), to: .bottom)
        #expect(d.zone(of: ref("a")) == .bottom)
        #expect(d.selected[.bottom] == ref("a"))
        #expect(d.ducklings(in: .right) == [ref("b")])
    }

    @Test func prunedKeepsOnlyItsChat() {
        var d = DockDucklings()
        d.open(ref("a"), in: .right)
        let other = SessionKey(provider: "native", hostSessionId: "s2")
        d.open(DucklingRef(session: other, taskId: "x"), in: .right)
        let p = d.pruned(keeping: [session])
        #expect(p.ducklings(in: .right) == [ref("a")])
        #expect(p.selected[.right] == nil || p.selected[.right] == ref("a"))
    }

    @Test func dragMatrixAndPayload() {
        let item = DockItem.duckling(ref("a"))
        #expect(DragScope.allows(item, on: .rightStrip))
        #expect(DragScope.allows(item, on: .bottomStrip))
        #expect(DragScope.allows(item, on: .centreStrip))
        #expect(DragScope.allows(item, on: .edgeStrip(.centre)))
        #expect(DragScope.allows(item, on: .edgeStrip(.right)))
        #expect(!DragScope.allows(item, on: .pondList))
        #expect(DockItemPayload.decode(DockItemPayload.encode(item)) == item)
    }
}
