import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct WorkspaceTabOrderTests {
    @Test func activityCannotReorderExistingTabsAndNewChatsAppend() {
        var tabs = WorkspaceTabOrder()
        tabs.synchronize(workspace: "w", available: ["a", "b", "c"])
        tabs.synchronize(workspace: "w", available: ["c", "a", "b"])
        #expect(tabs.ordered(workspace: "w", available: ["b", "c", "a"]) == ["a", "b", "c"])
        tabs.synchronize(workspace: "w", available: ["d", "c", "a", "b"])
        #expect(tabs.ordered(workspace: "w", available: ["d", "c", "b", "a"]) == ["a", "b", "c", "d"])
    }

    @Test func manualOrderSurvivesRefreshWorkspaceSwitchAndStorage() throws {
        var tabs = WorkspaceTabOrder()
        tabs.synchronize(workspace: "one", available: ["a", "b", "c"])
        tabs.synchronize(workspace: "two", available: ["x", "y"])
        let moved = tabs.move(workspace: "one", source: "c", before: "a", available: ["a", "b", "c"])
        #expect(moved)
        tabs.synchronize(workspace: "one", available: ["b", "a", "c"])
        let restored = try JSONDecoder().decode(WorkspaceTabOrder.self, from: JSONEncoder().encode(tabs))
        #expect(restored.ordered(workspace: "one", available: ["a", "b", "c"]) == ["c", "a", "b"])
        #expect(restored.ordered(workspace: "two", available: ["y", "x"]) == ["x", "y"])
    }

    @Test func closedTabsDisappearAndForeignOrInvalidDropsDoNothing() {
        var tabs = WorkspaceTabOrder()
        tabs.synchronize(workspace: "w", available: ["a", "b", "c"])
        tabs.synchronize(workspace: "w", available: ["c", "a"])
        #expect(tabs.ordered(workspace: "w", available: ["c", "a", "d", "d"]) == ["a", "c", "d"])
        let before = tabs
        let foreign = tabs.move(workspace: "w", source: "elsewhere", before: "a", available: ["a", "c"])
        let unchanged = tabs.move(workspace: "w", source: "a", before: "a", available: ["a", "c"])
        #expect(!foreign)
        #expect(!unchanged)
        #expect(tabs == before)
    }

    @Test func partialSnapshotsDoNotEraseRememberedPositions() {
        var tabs = WorkspaceTabOrder()
        tabs.synchronize(workspace: "w", available: ["a", "b", "c"])
        tabs.synchronize(workspace: "w", available: ["c", "a"])
        #expect(tabs.ordered(workspace: "w", available: ["c", "a"]) == ["a", "c"])
        tabs.synchronize(workspace: "w", available: ["c", "b", "a"])
        #expect(tabs.ordered(workspace: "w", available: ["c", "b", "a"]) == ["a", "b", "c"])
    }

    @Test func draggingDuringPartialSnapshotPreservesAbsentTabs() {
        var tabs = WorkspaceTabOrder()
        tabs.synchronize(workspace: "w", available: ["a", "b", "c", "d"])
        tabs.synchronize(workspace: "w", available: ["a", "c", "d"])
        let moved = tabs.move(workspace: "w", source: "d", before: "a", available: ["a", "c", "d"])
        #expect(moved)
        #expect(tabs.ordered(workspace: "w", available: ["a", "c", "d"]) == ["d", "a", "c"])
        tabs.synchronize(workspace: "w", available: ["a", "b", "c", "d"])
        #expect(tabs.ordered(workspace: "w", available: ["a", "b", "c", "d"]) == ["d", "a", "b", "c"])
        let absent = tabs.move(workspace: "w", source: "b", before: "a", available: ["a", "c", "d"])
        #expect(!absent)
    }
}
