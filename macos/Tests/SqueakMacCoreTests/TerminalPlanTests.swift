import Testing
import Foundation
@testable import SqueakMacCore

@Suite struct TerminalPlanTests {
    @Test func showAfterHideIsSameTab() {
        var r = TerminalRegistry()
        let first = r.show("a")
        #expect(first.spawn)
        let again = r.show("a")
        #expect(!again.spawn)
        #expect(again.tab.id == first.tab.id)
        #expect(r.tabs("a").count == 1)
    }

    @Test func lastTabClosedMakesANewOne() {
        var r = TerminalRegistry()
        let t = r.show("a").tab
        let repl = r.end("a", t.id)
        #expect(repl != nil)
        #expect(repl?.id != t.id)
        #expect(r.tabs("a") == [repl!])
        #expect(r.selected("a") == repl)
    }

    @Test func shellExitRemovesTabAndOnlyReplacesTheLast() {
        var r = TerminalRegistry()
        let one = r.show("a").tab
        let two = r.add("a")
        #expect(r.end("a", two.id) == nil)
        #expect(r.selected("a") == one)
        #expect(r.end("a", one.id) != nil)
        #expect(r.end("a", UUID()) == nil)
    }

    @Test func switchingWorkspaceAndBackKeepsTab() {
        var r = TerminalRegistry()
        let a = r.show("a").tab
        let b = r.show("b")
        #expect(b.spawn && b.tab.id != a.id)
        let back = r.show("a")
        #expect(!back.spawn && back.tab.id == a.id)
    }

    @Test func stoppedMessageOnlyWhenGuardLeftItEmpty() {
        #expect(!TerminalPlan.shouldRespawn(lived: 0.1))
        #expect(TerminalPlan.shouldRespawn(lived: 2))
        #expect(TerminalPlan.showsStopped(hasTabs: false, guardStopped: true))
        #expect(!TerminalPlan.showsStopped(hasTabs: true, guardStopped: true))
        #expect(!TerminalPlan.showsStopped(hasTabs: false, guardStopped: false))
        #expect(TerminalPlan.stoppedMessage(exitCode: nil) == "The shell stopped right away.")
        #expect(TerminalPlan.stoppedMessage(exitCode: 127).contains("127"))
    }
}
