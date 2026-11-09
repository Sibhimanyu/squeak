import Testing
@testable import SqueakMacCore

struct DiffTabsTests {
    @Test func showOpensOnceAndActivates() {
        var t = DiffTabs()
        t.show(.file("a.swift")); t.show(.file("b.swift")); t.show(.file("a.swift"))
        #expect(t.open == [.file("a.swift"), .file("b.swift")])
        #expect(t.active == .file("a.swift"))
    }

    @Test func closingTheActiveTabShowsItsNeighbour() {
        var t = DiffTabs()
        t.show(.file("a")); t.show(.all); t.show(.file("c"))
        t.close(.file("c"))
        #expect(t.active == .all)
        t.close(.file("a"))
        #expect(t.active == .all)
        t.close(.all)
        #expect(t.active == nil)
        #expect(t.open.isEmpty)
    }

    @Test func closingAnInactiveTabKeepsTheActiveOne() {
        var t = DiffTabs()
        t.show(.file("a")); t.show(.file("b"))
        t.close(.file("a"))
        #expect(t.active == .file("b"))
    }

    @Test func reopenBringsBackNewestFirst() {
        var t = DiffTabs()
        t.show(.file("a")); t.show(.file("b"))
        t.close(.file("a")); t.close(.file("b"))
        #expect(t.hasClosed)
        #expect(t.reopen() == .file("b"))
        #expect(t.reopen() == .file("a"))
        #expect(t.reopen() == nil)
        #expect(t.active == .file("a"))
    }

    @Test func closedListIsBoundedAndDeduplicated() {
        var t = DiffTabs()
        for i in 0..<15 { t.show(.file("f\(i)")); t.close(.file("f\(i)")) }
        #expect(t.closed.count == DiffTabs.closedLimit)
        #expect(t.closed.last == .file("f14"))
    }

    @Test func pruneDropsFilesNoLongerChanged() {
        var t = DiffTabs()
        t.show(.file("a")); t.show(.all); t.show(.file("b"))
        t.close(.file("a"))
        t.toggleFold("b")
        t.prune(changed: ["c"])
        #expect(t.open == [.all])
        #expect(t.active == .all)
        #expect(!t.hasClosed)
        #expect(t.folded.isEmpty)
    }

    @Test func foldToggles() {
        var t = DiffTabs()
        t.toggleFold("a")
        #expect(t.isFolded("a"))
        t.toggleFold("a")
        #expect(!t.isFolded("a"))
    }

    @Test func windowCapsLargeDiffsUntilShownInFull() {
        #expect(DiffWindow.visible(total: 100, showingAll: false) == 100)
        #expect(DiffWindow.visible(total: 5000, showingAll: false) == DiffWindow.cap)
        #expect(DiffWindow.hidden(total: 5000, showingAll: false) == 5000 - DiffWindow.cap)
        #expect(DiffWindow.hidden(total: 5000, showingAll: true) == 0)
    }
}
