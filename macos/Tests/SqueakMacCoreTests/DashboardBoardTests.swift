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

    // The greenroom bug: an errored Needs-you card drew an animated glyph on its stream line because sibling Ducks worked.
    // The line is text only now; the card's state is its destination chat's own mark, which never animates here.
    @Test func aNeedsYouCardNeverAnimatesAGlyphWhileSiblingsWork() {
        var failed = chat("failed", workspace: "greenroom", state: .error)
        failed.title = "Zoom SDK Video Subscription Instability"
        var sibling = chat("sibling", workspace: "greenroom", state: .working)
        sibling.ducklings = DucklingSet(running: 1)
        let workspace = SidebarTreeBuilder.build([failed, sibling, chat("third", workspace: "greenroom", state: .working)], now: now).projects[0].workspaces[0]
        #expect(DashboardBoard.lane(for: workspace, now: now) == .needsYou)
        let dest = try? #require(DashboardBoard.destination(in: workspace, now: now))
        #expect(dest?.key.hostSessionId == "failed")
        // The rollup would read working (a sibling works): that is exactly what the card must not draw.
        let rollup = StreamGlyphState.of(chats: workspace.chats, mark: { ChatMark.of($0, unread: false, now: now) })
        #expect(rollup == .working)
        // What the card does draw: the destination chat's own mark, failed, not animated.
        let mark = dest.flatMap { ChatMark.of($0, unread: false, now: now) }
        #expect(mark?.kind == .failed)
        #expect(StreamGlyphState.failed.glyph(reduceMotion: false) == StreamGlyphState.idle.glyph(reduceMotion: false))
        #expect(DashboardBoard.streamLine(in: workspace) == "greenroom")
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

    // The greenroom bug (ducksOwnBranch): a pond is one row holding every Duck, so its card took the errored Duck's state and
    // folded the working ones into "3 ducks". Each Duck is its own card now, in the lane of its own chats.
    private func duck(_ id: String, duck: String?, state: SessionState, ducklings: Int = 0, cwd: String? = nil) -> HostSession {
        var c = chat(id, workspace: "greenroom", state: state)
        c.duckId = duck
        c.cwd = cwd
        c.branch = nil
        c.repoName = "greenroom"
        if ducklings > 0 { c.ducklings = DucklingSet(running: ducklings) }
        return c
    }

    @Test func pondWideDucksWithNoWorkspaceEachLandInTheirOwnLane() {
        let chats = [
            duck("zoom", duck: "d-zoom", state: .error),
            duck("pickle", duck: "d-pickle", state: .finished, ducklings: 1),
            duck("dhol", duck: "d-dhol", state: .working, ducklings: 2),
        ]
        let tree = SidebarTreeBuilder.build(chats, now: now, ducksMode: true)
        let columns = DashboardBoard.build(tree, now: now)
        let titles = { (lane: DashboardLane) in columns.first { $0.lane == lane }!.workspaces.flatMap(\.workspace.chats).map(\.title).sorted() }
        #expect(titles(.needsYou) == ["zoom"])
        #expect(titles(.working) == ["dhol", "pickle"])
        #expect(columns.flatMap(\.workspaces).count == 3)
        #expect(Set(columns.flatMap(\.workspaces).map(\.id)).count == 3)
    }

    @Test func oneWorkspaceHoldingAnErroredAndTwoWorkingDucksShowsAllThree() {
        let dir = "/w/greenroom"
        let chats = [
            duck("zoom", duck: "d-zoom", state: .error, cwd: dir),
            duck("pickle", duck: "d-pickle", state: .working, ducklings: 1, cwd: dir),
            duck("dhol", duck: "d-dhol", state: .working, ducklings: 2, cwd: dir),
        ]
        let columns = DashboardBoard.build(SidebarTreeBuilder.build(chats, now: now, ducksMode: true), now: now)
        let inLane = { (lane: DashboardLane) in columns.first { $0.lane == lane }!.workspaces.flatMap(\.workspace.chats).map(\.title).sorted() }
        #expect(inLane(.working) == ["dhol", "pickle"])
        #expect(inLane(.needsYou) == ["zoom"])
        // Each card's glyph comes from its own chat.
        let working = columns.first { $0.lane == .working }!.workspaces
        #expect(working.allSatisfy { DashboardBoard.destination(in: $0.workspace, now: now)?.state == .working })
        #expect(DashboardBoard.ducklingTotals(columns).running == 3)
        // A plain stream (not ducks mode) stays one card, in the most urgent lane.
        let stream = DashboardBoard.build(SidebarTreeBuilder.build(chats, now: now), now: now)
        #expect(stream.first { $0.lane == .needsYou }!.workspaces.count == 1)
    }

    @Test func aDuckWithSeveralChatsIsOneCardAndAChatWithNoDuckIsItsOwn() {
        let chats = [
            duck("a1", duck: "d", state: .finished), duck("a2", duck: "d", state: .working),
            duck("solo", duck: nil, state: .working),
        ]
        let columns = DashboardBoard.build(SidebarTreeBuilder.build(chats, now: now, ducksMode: true), now: now)
        #expect(columns.flatMap(\.workspaces).count == 2)
        #expect(columns.first { $0.lane == .working }!.workspaces.count == 2)
    }

    @Test func theWorkspaceFilterKeepsAPondRowsDuckCards() {
        let tree = SidebarTreeBuilder.build([duck("x", duck: "d1", state: .working), duck("y", duck: "d2", state: .error)], now: now, ducksMode: true)
        let row = tree.projects[0].workspaces[0]
        let board = DashboardBoard.build(tree, now: now)
        #expect(DashboardFilter.workspace(id: row.id, name: "greenroom").apply(to: board).flatMap(\.workspaces).count == 2)
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
