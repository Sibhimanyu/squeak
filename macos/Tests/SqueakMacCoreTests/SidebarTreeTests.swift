import Foundation
import Testing
@testable import SqueakMacCore

private func chat(_ id: String, _ title: String, provider: String = "conductor", repo: String = "squeak", branch: String? = nil,
                  cwd: String? = nil, workspace: String? = nil, state: SessionState = .finished, ago: TimeInterval = 60,
                  now: Date) -> HostSession {
    HostSession(key: SessionKey(provider: provider, workspaceId: workspace, hostSessionId: id), title: title, repoName: repo,
                branch: branch, cwd: cwd, agent: provider.hasPrefix("codex") ? "codex" : "claude", state: state,
                lastActivityAt: now.addingTimeInterval(-ago), alive: true, conductorWorkspaceId: workspace)
}

@Suite("Sidebar tree")
struct SidebarTreeTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func projectsWorkspacesAndChatsAreNewestFirst() {
        let list = [
            chat("1", "a", cwd: "/w/squeak/mallard", ago: 900, now: now),
            chat("2", "b", cwd: "/w/squeak/heron", ago: 30, now: now),
            chat("3", "c", cwd: "/w/squeak/mallard", ago: 100, now: now),
            chat("4", "d", repo: "blume", cwd: "/w/blume/x", ago: 5, now: now),
        ]
        let t = SidebarTreeBuilder.build(list, now: now)
        #expect(t.projects.map(\.name) == ["blume", "squeak"])
        let squeak = t.projects[1]
        #expect(squeak.workspaces.map(\.name) == ["heron", "mallard"])
        #expect(squeak.workspaces[1].chats.map(\.title) == ["c", "a"])
    }

    @Test func needsYouIsALinkNotAMove() {
        let list = [
            chat("1", "quiet", cwd: "/w/squeak/mallard", ago: 10, now: now),
            chat("2", "asks", cwd: "/w/squeak/mallard", state: .blocked, ago: 500, now: now),
        ]
        let t = SidebarTreeBuilder.build(list, now: now)
        #expect(t.needsYou.map(\.title) == ["asks"])
        // The blocked chat keeps its place (older, so second) in the tree.
        #expect(t.projects[0].workspaces[0].chats.map(\.title) == ["quiet", "asks"])
        #expect(t.projects[0].workspaces[0].topState == .needsYou)
        #expect(t.projects[0].topState == .needsYou)
        #expect(t.totals == "1 needs you")
    }

    @Test func collapsedDotIsTheHighestPriorityStateAndIdleShowsNone() {
        let w = SidebarTreeBuilder.build([
            chat("1", "w", cwd: "/a", state: .working, now: now),
            chat("2", "d", cwd: "/a", state: .finished, now: now),
            chat("3", "e", cwd: "/b", state: .error, now: now),
            chat("4", "i", cwd: "/c", state: .idle, ago: 120, now: now),
        ], now: now).projects[0].workspaces
        #expect(w.first { $0.name == "a" }?.topState == .working)
        #expect(w.first { $0.name == "b" }?.topState == .error)
        let c = w.first { $0.name == "c" }
        #expect(c != nil && c?.topState == nil)
    }

    @Test func nativeChatsGroupByRepoAndFolderWithoutAConductorChip() throws {
        let json = """
        {"active":[{"key":"claude:abc","agent":"claude","origin":"squeak","state":"working","title":"Fix it",
        "repoName":"squeak","branch":"sib/mallard","cwd":"/w/squeak/mallard","replyTarget":"claude:abc"}]}
        """
        let native = try JSONDecoder().decode(DaemonState.self, from: Data(json.utf8)).sessions.map(ConductorDaemonAdapter.map)[0]
        #expect(native.key.provider == "claude-squeak")
        #expect(native.source == .squeak)
        #expect(native.origin == .squeakManaged)
        #expect(!native.showsConductorBadge)
        let cond = chat("9", "c", cwd: "/w/squeak/mallard", workspace: "ws1", now: now)
        let t = SidebarTreeBuilder.build([native, cond], now: now)
        #expect(t.projects.map(\.name) == ["squeak"])
        // Native chat is grouped by its folder; Conductor's by its workspace id: two workspaces, one project.
        #expect(t.projects[0].workspaces.count == 2)
        #expect(t.place(of: native.key)?.workspace.branch == "sib/mallard")
        #expect(cond.showsConductorBadge)
    }

    @Test func earlierChatsStayOffUnlessOpen() {
        let old = chat("1", "old", state: .idle, ago: 3 * 86_400, now: now)
        #expect(SidebarTreeBuilder.build([old], now: now).projects.isEmpty)
        #expect(SidebarTreeBuilder.build([old], now: now, keeping: old.key).place(of: old.key) != nil)
    }

    @Test func relativeAge() {
        #expect(RelativeAge.short(now.addingTimeInterval(-10), now: now) == "now")
        #expect(RelativeAge.short(now.addingTimeInterval(-300), now: now) == "5m")
        #expect(RelativeAge.short(now.addingTimeInterval(-7200), now: now) == "2h")
        #expect(RelativeAge.short(now.addingTimeInterval(-3 * 86_400), now: now) == "3d")
        #expect(RelativeAge.short(now.addingTimeInterval(-15 * 86_400), now: now) == "2w")
        #expect(RelativeAge.short(nil, now: now) == "")
    }
}

@Suite("Chat title")
struct ChatTitleTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func fallbackTitleShowsTheFirstMessageOrNewChat() {
        let s = chat("1", "squeak · mallard", branch: "sibhi/mallard", cwd: "/w/squeak/mallard", now: now)
        #expect(ChatTitle.isFallback(s))
        #expect(ChatTitle.resolve(s, headline: "squeak · mallard", firstMessage: "  Fix the\nsplitter  ") == "Fix the splitter")
        #expect(ChatTitle.resolve(s, headline: "squeak · mallard", firstMessage: nil) == "New chat")
        let long = String(repeating: "word ", count: 30)
        #expect(ChatTitle.resolve(s, headline: "x", firstMessage: long).count <= 61)
    }

    @Test func aRealTitleIsLeftAlone() {
        let named = chat("2", "Fix the splitter", cwd: "/w/squeak/mallard", now: now)
        #expect(ChatTitle.resolve(named, headline: "Fix the splitter", firstMessage: "hello") == "Fix the splitter")
    }
}
