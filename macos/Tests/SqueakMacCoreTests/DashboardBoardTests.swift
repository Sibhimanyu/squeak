import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct DashboardBoardTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func chat(_ id: String, workspace: String, state: SessionState, ago: TimeInterval = 30, alive: Bool = true) -> HostSession {
        HostSession(key: SessionKey(provider: "conductor", hostSessionId: id), title: id, repoName: "squeak",
                    branch: workspace, cwd: "/w/\(workspace)", agent: "claude", state: state,
                    lastActivityAt: now.addingTimeInterval(-ago), alive: alive)
    }

    @Test func runningWorkDoesNotDisappearBehindAnUnreadFinish() {
        let tree = SidebarTreeBuilder.build([
            chat("finished", workspace: "one", state: .finished),
            chat("running", workspace: "one", state: .working, ago: 60),
        ], now: now, isUnread: { _ in true })
        let workspace = tree.projects[0].workspaces[0]
        #expect(DashboardBoard.lane(for: workspace, now: now) == .working)
        #expect(DashboardBoard.destination(in: workspace, now: now)?.key.hostSessionId == "running")
    }

    @Test func aFinishedChatWithARunningDucklingIsInProgress() {
        var c = chat("quack", workspace: "one", state: .finished)
        c.ducklings = DucklingSet(running: 1)
        let tree = SidebarTreeBuilder.build([c], now: now, isUnread: { _ in false })
        let workspace = tree.projects[0].workspaces[0]
        #expect(DashboardBoard.lane(for: workspace, now: now) == .working)
        #expect(SessionGrouping.kind(of: c, now: now) == .working)
        c.ducklings = DucklingSet(running: 0)
        #expect(SessionGrouping.kind(of: c, now: now) == .done)
        c.ducklings = DucklingSet(running: 1)
        c.alive = false
        #expect(SessionGrouping.kind(of: c, now: now) == .done)
    }

    @Test func waitingAndFailuresSurfaceWithTheChatThatNeedsAttention() {
        let tree = SidebarTreeBuilder.build([
            chat("running", workspace: "one", state: .working),
            chat("failed", workspace: "one", state: .error, ago: 60),
            chat("waiting", workspace: "one", state: .blocked, ago: 90),
        ], now: now)
        let workspace = tree.projects[0].workspaces[0]
        #expect(DashboardBoard.lane(for: workspace, now: now) == .needsYou)
        #expect(DashboardBoard.destination(in: workspace, now: now)?.key.hostSessionId == "waiting")
        let failed = SidebarTreeBuilder.build([chat("failed", workspace: "two", state: .error)], now: now).projects[0].workspaces[0]
        #expect(DashboardBoard.lane(for: failed, now: now) == .needsYou)
    }

    @Test func deadAgentsAreNotPresentedAsRunningOrWaiting() {
        let tree = SidebarTreeBuilder.build([
            chat("stopped", workspace: "one", state: .working, alive: false),
            chat("gone", workspace: "two", state: .blocked, alive: false),
        ], now: now)
        #expect(DashboardBoard.build(tree, now: now).first { $0.lane == .idle }?.workspaces.count == 2)
    }

    @Test func everyWorkspaceAppearsExactlyOnceWithoutTheOldFourteenItemLimit() {
        let chats = (0..<20).map { chat("\($0)", workspace: "work-\($0)", state: $0.isMultiple(of: 2) ? .working : .finished) }
        let columns = DashboardBoard.build(SidebarTreeBuilder.build(chats, now: now), now: now)
        let ids = columns.flatMap(\.workspaces).map(\.id)
        #expect(ids.count == 20)
        #expect(Set(ids).count == 20)
        #expect(columns.map(\.lane) == DashboardLane.allCases)
    }

    @Test func pinsComeFirstWithinEachLaneAndRecencyBreaksTies() {
        let tree = SidebarTreeBuilder.build([
            chat("new", workspace: "new", state: .working, ago: 10),
            chat("old", workspace: "old", state: .working, ago: 90),
            chat("middle", workspace: "middle", state: .working, ago: 30),
        ], now: now)
        let pin = tree.projects[0].workspaces.first { $0.name == "old" }!.id
        let column = DashboardBoard.build(tree, pins: [pin], now: now).first { $0.lane == .working }!
        #expect(column.workspaces.map(\.workspace.name) == ["old", "new", "middle"])
    }

    @Test func emptyBoardsKeepAllFourLanes() {
        let columns = DashboardBoard.build(SidebarTree(projects: []), now: now)
        #expect(columns.count == 4)
        #expect(columns.allSatisfy { $0.workspaces.isEmpty })
    }

    @Test func filterNarrowsTheBoardToAProjectOrOneWorkspace() {
        let tree = SidebarTreeBuilder.build([
            chat("a", workspace: "one", state: .working),
            chat("b", workspace: "two", state: .working),
        ], now: now)
        let board = DashboardBoard.build(tree, now: now)
        let ids = { (cols: [DashboardColumn]) in cols.flatMap(\.workspaces).map(\.workspace.id) }
        #expect(ids(board).count == 2)
        #expect(ids(DashboardFilter.project("SQUEAK").apply(to: board)).count == 2)
        #expect(ids(DashboardFilter.project("other").apply(to: board)).isEmpty)
        let target = tree.projects[0].workspaces[0]
        let one = DashboardFilter.workspace(id: target.id, name: "one").apply(to: board)
        #expect(ids(one) == [target.id])
        #expect(one.count == DashboardLane.allCases.count)
    }
}
