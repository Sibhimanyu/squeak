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

    @Test func theTerminalIconOpensThenClosesThePane() {
        var p = WorkPane()
        p.toggle(.terminal, duck: "a")
        #expect(p.shown == .terminal)
        p.toggle(.terminal, duck: "a")
        #expect(p.shown == nil)
        p.toggle(.terminal, duck: "a")
        #expect(p.shown == .terminal)
    }

    @Test func thePaneClosesOnSwitchingPageWithNoPin() {
        var p = WorkPane()
        p.open(.terminal, duck: "a")
        p.switched(to: "b")
        #expect(p.shown == nil)
        p.open(.terminal, duck: "b")
        p.switched(to: "a")
        #expect(p.shown == nil)
    }

    @Test func aPageOpeningTheTerminalSelectsItSoTheNextSwitchEventIsANoOp() {
        var p = WorkPane()
        p.switched(to: "a")
        p.open(.terminal, duck: "b")
        p.switched(to: "b")
        #expect(p.shown == .terminal)
    }

    @Test func widthIsRememberedPerPageAndClamped() {
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

    @Test func savedStateKeepsWidthsButNotOpenness() throws {
        var p = WorkPane()
        p.open(.terminal, duck: "a")
        p.setWidth(480, duck: "a")
        let back = try JSONDecoder().decode(WorkPane.self, from: JSONEncoder().encode(p))
        #expect(back.memory["a"] == WorkPane.Memory(view: .terminal, width: 480))
        #expect(!back.isOpen)
    }

    @Test func garbageSavedStateIsAnEmptyPane() throws {
        let back = try JSONDecoder().decode(WorkPane.self, from: Data(#"{"pinned":"x","memory":"nope"}"#.utf8))
        #expect(back.memory.isEmpty)
    }

    @Test func forgetDropsPagesThatAreGone() {
        var p = WorkPane()
        p.open(.terminal, duck: "a")
        p.open(.terminal, duck: "b")
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

    @Test func oldSavedViewsAndThePinReadBackAsTheTerminalPane() throws {
        let json = #"{"pinned":true,"memory":{"a":{"view":"canvas","width":480},"b":{"view":"files"}}}"#
        let p = try JSONDecoder().decode(WorkPane.self, from: Data(json.utf8))
        #expect(p.memory["a"] == WorkPane.Memory(view: .terminal, width: 480))
        #expect(p.memory["b"]?.view == .terminal)
        #expect(WorkPaneView.allCases == [.terminal])
    }
}
