import Testing
@testable import SqueakMacCore

struct ReviewStateTests {
    @Test func opensOnAFileAndCloses() {
        var r = ReviewState()
        #expect(!r.isOpen)
        r.open(file: "a.swift")
        #expect(r.isOpen && r.focus == "a.swift")
        r.focus("b.swift")
        #expect(r.focus == "b.swift")
        r.close()
        #expect(!r.isOpen && r.focus == nil)
    }

    @Test func openingAllHasNoFocus() {
        var r = ReviewState()
        r.open(file: "a"); r.open()
        #expect(r.isOpen && r.focus == nil)
    }

    @Test func pruneDropsFilesNoLongerChanged() {
        var r = ReviewState()
        r.open(file: "a"); r.toggleFold("a"); r.toggleFold("b")
        r.prune(changed: ["b"])
        #expect(r.isOpen)
        #expect(r.focus == nil)
        #expect(r.folded == ["b"])
    }

    @Test func foldToggles() {
        var r = ReviewState()
        r.toggleFold("a")
        #expect(r.isFolded("a"))
        r.toggleFold("a")
        #expect(!r.isFolded("a"))
    }

    @Test func windowCapsLargeDiffsUntilShownInFull() {
        #expect(DiffWindow.visible(total: 100, showingAll: false) == 100)
        #expect(DiffWindow.visible(total: 5000, showingAll: false) == DiffWindow.cap)
        #expect(DiffWindow.hidden(total: 5000, showingAll: false) == 5000 - DiffWindow.cap)
        #expect(DiffWindow.hidden(total: 5000, showingAll: true) == 0)
    }
}
