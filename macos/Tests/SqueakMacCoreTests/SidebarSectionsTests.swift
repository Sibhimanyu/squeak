import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct SidebarSectionsTests {
    private func chat(_ id: String, provider: String, repo: String?, cwd: String, at t: TimeInterval) -> HostSession {
        HostSession(
            key: SessionKey(provider: provider, hostSessionId: id), title: id, repoName: repo, cwd: cwd, state: .idle,
            lastActivityAt: Date(timeIntervalSince1970: t))
    }

    private func pond(_ id: String, _ folder: String) -> PondDirectory.Pond {
        PondDirectory.Pond(id: id, name: id, projectId: id, folder: folder)
    }

    @Test func chatsSitUnderTheDirectorysPondsAndTheRestGoToOtherSessions() {
        let now = Date(timeIntervalSince1970: 10_000)
        let sessions = [
            chat("a", provider: "conductor", repo: "squeak", cwd: "/r/squeak", at: 9_900),
            chat("b", provider: "claude-terminal", repo: nil, cwd: "/r/squeak/.context/tab-release", at: 9_950),
            chat("c", provider: "claude-terminal", repo: nil, cwd: "/tmp/scratch", at: 9_990),
            chat("squeak-native:d", provider: "claude-squeak", repo: "mallard", cwd: "/r/mallard", at: 9_800),
            chat("squeak-native:e", provider: "claude-squeak", repo: "stray", cwd: "/r/stray", at: 9_700),
        ]
        let tree = SidebarTreeBuilder.build(sessions, now: now)
        let directory = PondDirectory(
            ponds: [pond("p-squeak", "/r/squeak"), pond("p-mallard", "/r/mallard")],
            threads: ["squeak-native:d": "p-mallard", "squeak-native:e": nil])
        let s = SidebarSections.split(tree, directory: directory)
        #expect(s.chatCount(of: "p-squeak") == 2)
        #expect(s.chatCount(of: "p-mallard") == 1)
        // The host's null and an unplaced folder are Other; a repo name never makes a pond.
        #expect(s.otherSessions.map(\.title) == ["c", "squeak-native:e"])
    }

    @Test func aPondPageKeepsEarlierThreadsAndTheMainChat() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        func c(_ id: String, cwd: String, at: TimeInterval) -> HostSession {
            HostSession(key: SessionKey(provider: "claude-squeak", hostSessionId: "squeak-native:\(id)"), title: id, repoName: "abhishri-engine",
                        cwd: cwd, state: .finished, lastActivityAt: Date(timeIntervalSince1970: at))
        }
        let root = "/u/repos/abhishri-engine", dallas = "/u/ws/abhishri-engine/dallas"
        let sessions = [c("main", cwd: root, at: 999_900), c("d1", cwd: dallas, at: 100_000), c("d2", cwd: dallas, at: 100_100)]
        let main = MainPlace(projectId: "P", pondName: "abhishri-engine", rootPath: root, branch: "main")
        let dir = PondDirectory(
            ponds: [PondDirectory.Pond(id: "P", name: "abhishri-engine", projectId: "P", folder: root)],
            threads: Dictionary(uniqueKeysWithValues: sessions.map { ($0.key.hostSessionId, "P") }))
        // The sidebar keeps the active set; the page lists every non-archived thread, newest first inside each stream.
        let active = SidebarSections.split(SidebarTreeBuilder.build(sessions, now: now, mains: [main]), directory: dir, mains: [main])
        #expect(active.chatCount(of: "P") == 1)
        let full = SidebarSections.split(SidebarTreeBuilder.build(sessions, now: now, mains: [main], includeEarlier: true), directory: dir, mains: [main])
        #expect(full.chatCount(of: "P") == 3)
        let ws = full.workspaces(of: "P")
        #expect(ws.first?.isMain == true && ws.first?.chats.map(\.title) == ["main"])
        #expect(ws.last?.chats.map(\.title) == ["d2", "d1"])
        let layout = PondHomeLayout.build(project: SidebarProject(name: "abhishri-engine", workspaces: ws), detail: nil, me: "me", main: main, hostIdFor: { _ in nil })
        #expect(layout.count(in: .all) == 3 && layout.workspaces.first?.chats.count == 1)
    }

    @Test func nothingIsLost() {
        let now = Date(timeIntervalSince1970: 10_000)
        let sessions = (0..<6).map { chat("s\($0)", provider: $0 % 2 == 0 ? "conductor" : "codex-terminal", repo: "r\($0)", cwd: "/r/r\($0)", at: 9_000 + Double($0)) }
        let tree = SidebarTreeBuilder.build(sessions, now: now)
        let s = SidebarSections.split(tree, directory: PondDirectory(ponds: [pond("p0", "/r/r0"), pond("p1", "/r/r1")]))
        let total = s.workspacesByPond.values.joined().reduce(0) { $0 + $1.chats.count } + s.otherSessions.count
        #expect(total == 6)
    }

    @Test func diffStatAbbreviates() {
        #expect(DiffStatFormat.abbreviate(0) == "0")
        #expect(DiffStatFormat.abbreviate(205) == "205")
        #expect(DiffStatFormat.abbreviate(999) == "999")
        #expect(DiffStatFormat.abbreviate(1000) == "1k")
        #expect(DiffStatFormat.abbreviate(3000) == "3k")
        #expect(DiffStatFormat.abbreviate(5500) == "5.5k")
        #expect(DiffStatFormat.abbreviate(8420) == "8.4k")
        #expect(DiffStatFormat.abbreviate(9990) == "10k")
        #expect(DiffStatFormat.abbreviate(102_134) == "102k")
        #expect(DiffStatFormat.abbreviate(-4) == "0")
    }

    @Test func historyGoesBackAndForward() {
        var h = NavHistory<String>()
        #expect(!h.canGoBack && !h.canGoForward)
        h.visit(nil); h.visit("a"); h.visit("a"); h.visit("b")
        #expect(h.canGoBack && !h.canGoForward)
        #expect(h.back() == .some("a"))
        #expect(h.back() == .some(nil))
        #expect(h.back() == nil)
        #expect(h.forward() == .some("a"))
        h.visit("c")   // drops "b"
        #expect(!h.canGoForward)
        #expect(h.back() == .some("a"))
    }

    @Test func historyIsBounded() {
        var h = NavHistory<Int>()
        for i in 0..<200 { h.visit(i) }
        var steps = 0
        while h.back() != nil { steps += 1 }
        #expect(steps == NavHistory<Int>.limit - 1)
    }
}

@Suite struct NavHistoryLastVisitedTests {
    @Test func homeReturnsToTheLatestOpenablePlace() {
        var h = NavHistory<String>()
        h.visit("a"); h.visit("gone"); h.visit(nil)
        #expect(h.lastVisited(where: { $0 != "gone" }) == "a")
        #expect(h.lastVisited(where: { _ in false }) == nil)
    }
}

@Suite struct ChatTabsTests {
    @Test func closingTheOpenTabMovesToItsNeighbour() {
        #expect(ChatTabs.selectionAfterClosing("b", selected: "b", shown: ["a", "b", "c"]) == "c")
        #expect(ChatTabs.selectionAfterClosing("c", selected: "c", shown: ["a", "b", "c"]) == "b")
    }

    @Test func closingAnotherTabKeepsTheSelectionAndTheLastTabStays() {
        #expect(ChatTabs.selectionAfterClosing("a", selected: "b", shown: ["a", "b"]) == nil)
        #expect(ChatTabs.selectionAfterClosing("a", selected: "a", shown: ["a"]) == nil)
        #expect(ChatTabs.canClose(shown: 1) && ChatTabs.canClose(shown: 2) && !ChatTabs.canClose(shown: 0))
    }

    @Test func closingTheLastTabLeadsToTheFileTabOrThePondPage() {
        #expect(ChatTabs.afterClosingLast(fileTabOpen: false) == .pondPage)
        #expect(ChatTabs.afterClosingLast(fileTabOpen: true) == .showFile)
        #expect(CloseRouting.route(mainWindowKey: true, tabClosable: ChatTabs.canClose(shown: 1)) == .tab)
    }

    @Test func aClosedStreamTabIsReopenedWithItsChat() {
        var closed = ClosedTabs()
        closed.close("a", in: "w")
        #expect(closed.isClosed("a", in: "w"))
        #expect(closed.reopen(in: "w", available: ["a"]) == "a" && !closed.isClosed("a", in: "w"))
    }
}

@Suite struct LiveClockTests {
    @Test func theRunningLineReadsInWholeSeconds() {
        #expect(ElapsedFormat.live(0) == "0s")
        #expect(ElapsedFormat.live(38.14) == "38s")
        #expect(ElapsedFormat.live(225.8) == "3m 45s")
        #expect(ElapsedFormat.live(3_758.9) == "1h 2m")
        #expect(ElapsedFormat.live(-5) == "0s")
    }
}
