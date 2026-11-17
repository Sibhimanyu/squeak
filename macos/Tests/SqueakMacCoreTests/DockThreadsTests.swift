import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct DockThreadsTests {
    @Test func aThreadIsInOnePlace() {
        var t = DockThreads()
        t.move("a", to: .right)
        t.move("a", to: .bottom)
        #expect(t.zone(of: "a") == .bottom)
        #expect(t.threads(in: .right).isEmpty)
        #expect(t.threads(in: .bottom) == ["a"])
        t.move("a", to: .centre)
        #expect(!t.isDocked("a"))
        #expect(!t.has(in: .bottom))
    }

    @Test func reorderWithinAZone() {
        var t = DockThreads()
        for k in ["a", "b", "c"] { t.move(k, to: .right) }
        t.move("c", to: .right, before: "a")
        #expect(t.threads(in: .right) == ["c", "a", "b"])
        t.move("c", to: .right, before: "c")
        #expect(t.threads(in: .right) == ["c", "a", "b"])
    }

    @Test func selectionFallsToNeighbourAndPruneKeepsUnique() {
        var t = DockThreads()
        for k in ["a", "b"] { t.move(k, to: .right) }
        t.close("b")
        #expect(t.selected[.right] == "a")
        t.move("b", to: .right)
        let p = t.pruned(keeping: ["b"])
        #expect(p.threads(in: .right) == ["b"])
    }

    @Test func payloadRoundTripsAndKeepsPlainKeysOut() {
        #expect(DockItemPayload.decode(DockItemPayload.encode(.thread("k:1"))) == .thread("k:1"))
        #expect(DockItemPayload.decode("k:1") == nil)
    }

    @Test func aDockedThreadShowsItsZone() {
        var t = DockThreads()
        t.move("a", to: .bottom)
        let l = DockLayout.migrated(codeView: false, terminalOpen: false, inspectorOpen: false, inspectorWidth: 0, terminalHeight: 0)
        #expect(l.isZoneVisible(.bottom, files: DockFiles(), terminals: DockTerminals(), threads: t))
    }
}
