import Testing
@testable import SqueakMacCore

@Suite struct WorkspaceKeyedTests {
    private func ref(_ s: String) -> DucklingRef { DucklingRef(session: SessionKey(provider: "claude", hostSessionId: s), taskId: "d") }

    @Test func eachWorkspaceRecallsItsOwnSelection() {
        var k = WorkspaceKeyed<DockDucklings>(fallback: DockDucklings())
        k.switchTo("a")
        k.current.open(ref("1"), in: .centre)
        k.switchTo("b")
        #expect(k.current.selected[.centre] == nil)
        k.current.open(ref("2"), in: .right)
        k.switchTo("a")
        #expect(k.current.selected[.centre] == ref("1"))
        #expect(k.current.selected[.right] == nil)
        k.switchTo("b")
        #expect(k.current.selected[.right] == ref("2"))
    }

    @Test func writesBeforeAnyWorkspaceAreKeptInTheirOwnSlot() {
        var k = WorkspaceKeyed<Int>(fallback: 0)
        k.current = 5
        #expect(k.current == 5)
        k.switchTo("a")
        #expect(k.current == 0)
        k.switchTo(nil)
        #expect(k.current == 5)
    }

    @Test func filesAndThreadsAreRememberedPerWorkspace() {
        var f = WorkspaceKeyed<DockFiles>(fallback: DockFiles())
        f.switchTo("a"); f.current.move("/x", to: .right); f.current.select("/x")
        f.switchTo("b")
        #expect(f.current.selected[.right] == nil)
        f.switchTo("a")
        #expect(f.current.selected[.right] == "/x")
        var t = WorkspaceKeyed<DockThreads>(fallback: DockThreads())
        t.switchTo("a"); t.current.move("k", to: .bottom)
        t.switchTo("b"); #expect(!t.current.isDocked("k"))
        t.switchTo("a"); #expect(t.current.isDocked("k"))
    }

    @Test func vanishedWorkspacesAndSessionsArePruned() {
        var k = WorkspaceKeyed<DockDucklings>(fallback: DockDucklings())
        k.switchTo("a"); k.current.open(ref("1"))
        k.switchTo("b"); k.current.open(ref("2"))
        k.transformAll { $0.pruned(keeping: [SessionKey(provider: "claude", hostSessionId: "2")]) }
        #expect(k.stored("a") == nil)
        #expect(k.stored("b") != nil)
        k.prune(keeping: ["a"])
        #expect(k.stored("b") == nil)
    }

    @Test func settingTheFallbackClearsTheEntry() {
        var k = WorkspaceKeyed<DockPanel?>(fallback: nil)
        k.switchTo("a"); k.current = .pond
        #expect(k.stored("a") != nil)
        k.current = nil
        #expect(k.stored("a") == nil)
    }
}
