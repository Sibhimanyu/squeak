import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct WorkPaneTests {
    @Test func startsClosedAndDoesNotOpenBySwitchingOrResizing() {
        var p = WorkPane()
        p.switched(to: "a")
        p.setWidth(500, duck: "a")
        #expect(p.shown == nil)
        #expect(!p.isOpen)
    }

    @Test func iconOpensThenSameIconCloses() {
        var p = WorkPane()
        p.toggle(.files, duck: "a")
        #expect(p.shown == .files)
        p.toggle(.terminal, duck: "a")
        #expect(p.shown == .terminal)
        p.toggle(.terminal, duck: "a")
        #expect(p.shown == nil)
        p.toggle(.terminal, duck: "a")
        #expect(p.shown == .terminal)
    }

    @Test func unpinnedPaneClosesOnSwitchAndKeepsEachDucksLastView() {
        var p = WorkPane()
        p.open(.files, duck: "a")
        p.switched(to: "b")
        #expect(p.shown == nil)
        p.open(.canvas, duck: "b")
        p.switched(to: "a")
        #expect(p.shown == nil)
        p.toggle(.changes, duck: "a")
        p.close()
        p.switched(to: "b")
        p.open(.canvas, duck: "b")
        #expect(p.memory["a"]?.view == .changes)
        #expect(p.memory["b"]?.view == .canvas)
    }

    @Test func pinnedPaneStaysOpenAcrossDucksAndCarriesViewToANewDuck() {
        var p = WorkPane()
        p.open(.terminal, duck: "a")
        p.setPinned(true)
        p.switched(to: "b")
        #expect(p.shown == .terminal)
        p.open(.files, duck: "b")
        p.switched(to: "a")
        #expect(p.shown == .terminal)
        p.switched(to: "b")
        #expect(p.shown == .files)
    }

    @Test func pinnedButClosedStaysClosedOnSwitch() {
        var p = WorkPane()
        p.setPinned(true)
        p.open(.files, duck: "a")
        p.close()
        p.switched(to: "b")
        #expect(p.shown == nil)
    }

    @Test func aDuckOpeningSomethingSelectsItsDuckSoTheNextSwitchEventIsANoOp() {
        var p = WorkPane()
        p.switched(to: "a")
        p.open(.files, duck: "b")
        p.switched(to: "b")
        #expect(p.shown == .files)
    }

    @Test func widthIsRememberedPerDuckAndClamped() {
        var p = WorkPane()
        p.setWidth(500, duck: "a")
        p.setWidth(10_000, duck: "b")
        p.setWidth(.nan, duck: "c")
        #expect(p.storedWidth(duck: "a") == 500)
        #expect(p.storedWidth(duck: "b") == WorkPaneMetrics.range.upperBound)
        #expect(p.storedWidth(duck: "c") == nil)
        p.resetWidth(duck: "a")
        #expect(p.storedWidth(duck: "a") == nil)
    }

    @Test func drawnWidthKeepsTheChatItsMinimum() {
        let roomy = WorkPaneMetrics.drawn(stored: 600, window: 1800, sidebar: 256)
        #expect(roomy == 600)
        let tight = WorkPaneMetrics.drawn(stored: 600, window: 1000, sidebar: 256)
        #expect(tight == max(WorkPaneMetrics.range.lowerBound, 1000 - 256 - WorkPaneMetrics.railWidth - PaneWidths.centreMin))
        #expect(WorkPaneMetrics.drawn(stored: nil, window: 2000, sidebar: 256) == WorkPaneMetrics.defaultWidth)
    }

    @Test func savedStateKeepsPinViewsAndWidthsButNotOpenness() throws {
        var p = WorkPane()
        p.open(.canvas, duck: "a")
        p.setWidth(480, duck: "a")
        p.setPinned(true)
        let back = try JSONDecoder().decode(WorkPane.self, from: JSONEncoder().encode(p))
        #expect(back.pinned)
        #expect(back.memory["a"] == WorkPane.Memory(view: .canvas, width: 480))
        #expect(!back.isOpen)
    }

    @Test func garbageSavedStateIsAnEmptyPane() throws {
        let back = try JSONDecoder().decode(WorkPane.self, from: Data(#"{"pinned":"x","memory":{"a":{"view":"bogus"}}}"#.utf8))
        #expect(!back.pinned)
        #expect(back.memory.isEmpty)
    }

    @Test func forgetDropsDucksThatAreGone() {
        var p = WorkPane()
        p.open(.files, duck: "a")
        p.open(.files, duck: "b")
        p.forget(keeping: ["b"])
        #expect(p.memory.keys.sorted() == ["b"])
    }

    @Test func badgesAndKeys() {
        #expect(WorkPaneMetrics.badge(count: nil) == nil)
        #expect(WorkPaneMetrics.badge(count: 0) == nil)
        #expect(WorkPaneMetrics.badge(count: 7) == "7")
        #expect(WorkPaneMetrics.badge(count: 250) == "99+")
        #expect(WorkPaneMetrics.duckKey(duckId: "d1", sessionKey: "s") == "duck:d1")
        #expect(WorkPaneMetrics.duckKey(duckId: nil, sessionKey: "s") == "chat:s")
    }
}
