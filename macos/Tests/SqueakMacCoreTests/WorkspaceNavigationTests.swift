import Foundation
import Testing
@testable import SqueakMacCore

private func chat(_ id: String, repo: String = "squeak", cwd: String, state: SessionState = .finished, ago: TimeInterval = 60, now: Date) -> HostSession {
    HostSession(key: SessionKey(provider: "conductor", workspaceId: nil, hostSessionId: id), title: id, repoName: repo, branch: nil, cwd: cwd,
                agent: "claude", state: state, lastActivityAt: now.addingTimeInterval(-ago), alive: true)
}

@Suite struct WorkspaceNavigationTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func tree(_ unread: Set<String> = []) -> SidebarTree {
        SidebarTreeBuilder.build([
            chat("a", cwd: "/w/squeak/heron", ago: 30, now: now),
            chat("b", cwd: "/w/squeak/mallard", state: .blocked, ago: 90, now: now),
            chat("c", repo: "blume", cwd: "/w/blume/x", ago: 10, now: now),
            chat("d", cwd: "/w/squeak/teal", ago: 200, now: now),
        ], now: now, isUnread: { unread.contains($0.key.hostSessionId) })
    }
    private func key(_ id: String) -> SessionKey { SessionKey(provider: "conductor", workspaceId: nil, hostSessionId: id) }
    private func mark(_ unread: Set<String>) -> (HostSession) -> ChatMark? { { ChatMark.of($0, unread: unread.contains($0.key.hostSessionId), now: self.now) } }

    @Test func homeListsWorkspacesNewestFirstAcrossProjects() {
        #expect(WorkspaceNavigation.recent(tree()).map(\.workspace.name) == ["x", "heron", "mallard", "teal"])
        #expect(WorkspaceNavigation.recent(tree(), limit: 2).count == 2)
    }

    @Test func pinnedWorkspacesGoFirstInTheirProjectOnly() {
        let t = tree()
        let ids = t.projects.flatMap(\.workspaces).filter { $0.name == "teal" }.map(\.id)
        let flat = WorkspaceNavigation.flat(t, pins: Set(ids))
        #expect(flat.map(\.name) == ["x", "teal", "heron", "mallard"])
    }

    @Test func stepsWrapBothWays() {
        let t = tree()
        #expect(WorkspaceNavigation.step(from: key("c"), by: 1, in: t)?.name == "heron")
        #expect(WorkspaceNavigation.step(from: key("c"), by: -1, in: t)?.name == "teal")
        #expect(WorkspaceNavigation.step(from: key("d"), by: 1, in: t)?.name == "x")
        #expect(WorkspaceNavigation.step(from: nil, by: -1, in: t)?.name == "teal")
        #expect(WorkspaceNavigation.step(from: nil, by: 1, in: SidebarTree(projects: [])) == nil)
    }

    @Test func nextAttentionPrefersWaitingThenUnreadAndSkipsTheOpenChat() {
        let unread: Set<String> = ["d"]
        let t = tree(unread)
        #expect(WorkspaceNavigation.nextAttention(after: key("c"), in: t, mark: mark(unread)) == key("b"))
        // From the waiting chat itself: the unread one is next.
        #expect(WorkspaceNavigation.nextAttention(after: key("b"), in: t, mark: mark(unread)) == key("d"))
        #expect(WorkspaceNavigation.nextAttention(after: key("c"), in: tree(), mark: mark([])) == key("b"))
        #expect(WorkspaceNavigation.attentionCount(excluding: key("b"), in: t, mark: mark(unread)) == 1)
        #expect(WorkspaceNavigation.nextAttention(after: key("a"), in: SidebarTreeBuilder.build([chat("a", cwd: "/w/s/h", now: now)], now: now), mark: mark([])) == nil)
    }

    @Test func closedTabsReopenNewestFirstAndSkipGoneChats() {
        var c = ClosedTabs()
        c.close("a", in: "w"); c.close("b", in: "w"); c.close("c", in: "w")
        #expect(c.isClosed("b", in: "w") && !c.isClosed("b", in: "other"))
        #expect(c.reopen(in: "w", available: ["a", "b"]) == "b")
        #expect(c.reopen(in: "w", available: ["a", "b"]) == "a")
        #expect(c.reopen(in: "w", available: ["a", "b"]) == nil)
        c.close("a", in: "w"); c.forget("a", in: "w")
        #expect(!c.isClosed("a", in: "w"))
    }

    @Test func pinsToggle() {
        var p = WorkspacePins()
        #expect(p.toggle("w") == true && p.contains("w"))
        #expect(p.toggle("w") == false && !p.contains("w"))
    }

    @Test func markUnreadMakesAFinishedChatUnreadAgain() {
        var log = ChatSeenLog()
        let s = chat("a", cwd: "/w/s/h", ago: 30, now: now)
        log.markOpened(s, now: now)
        #expect(!log.isUnread(s, now: now))
        log.markUnread(s)
        #expect(log.isUnread(s, now: now))
    }

    @Test func theJumpPillSaysWhatIsNextAndHowManyWait() {
        let unread: Set<String> = ["d"]
        let jump = AttentionJump.make(after: key("c"), in: tree(unread), mark: mark(unread))
        #expect(jump?.key == key("b") && jump?.kind == .waiting && jump?.count == 2)
        #expect(jump?.label == "Next request · 2")
        let one = AttentionJump.make(after: key("c"), in: tree([]), mark: mark([]))
        #expect(one?.label == "Next request")
        #expect(AttentionJump.make(after: key("b"), in: tree(["d"]), mark: mark(["d"]))?.label == "Next update")
    }

    @Test func theChatOnScreenIsNeverTheNextOne() {
        // The selected key is a started chat's stand-in (another provider spelling, same host id): still the same chat.
        let t = tree(["d"])
        let standIn = SessionKey(provider: "claude-squeak", workspaceId: nil, hostSessionId: "d")
        #expect(AttentionJump.make(after: standIn, in: t, mark: mark(["d"]))?.key != key("d"))
        #expect(WorkspaceNavigation.attentionCount(excluding: standIn, in: t, mark: mark(["d"])) == 1)
    }

    @Test func noButtonWhenNothingElseNeedsYou() {
        let t = SidebarTreeBuilder.build([
            chat("a", cwd: "/w/squeak/heron", state: .working, ago: 5, now: now),
            chat("b", cwd: "/w/squeak/mallard", ago: 90, now: now),
        ], now: now, isUnread: { _ in false })
        #expect(AttentionJump.make(after: key("a"), in: t, mark: mark([])) == nil)
        #expect(AttentionJump.make(after: nil, in: t, mark: mark([])) == nil)
    }
}
