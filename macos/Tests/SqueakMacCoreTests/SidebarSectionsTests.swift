import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct SidebarSectionsTests {
    private func chat(_ id: String, provider: String, repo: String?, cwd: String, at t: TimeInterval) -> HostSession {
        HostSession(
            key: SessionKey(provider: provider, hostSessionId: id), title: id, repoName: repo, cwd: cwd, state: .idle,
            lastActivityAt: Date(timeIntervalSince1970: t))
    }

    @Test func realProjectsStayAndOtherFoldersGoToOtherSessions() {
        let now = Date(timeIntervalSince1970: 10_000)
        let sessions = [
            chat("a", provider: "conductor", repo: "squeak", cwd: "/r/squeak", at: 9_900),
            chat("b", provider: "claude-terminal", repo: nil, cwd: "/r/squeak/.context/tab-release", at: 9_950),
            chat("c", provider: "claude-terminal", repo: nil, cwd: "/tmp/scratch", at: 9_990),
            chat("d", provider: "claude-squeak", repo: "mallard", cwd: "/r/mallard", at: 9_800),
            chat("e", provider: "claude-terminal", repo: "native-only", cwd: "/r/native-only", at: 9_700),
        ]
        let tree = SidebarTreeBuilder.build(sessions, now: now)
        let s = SidebarSections.split(tree, nativeNames: ["Native-Only"])
        #expect(Set(s.projects.map(\.name)) == ["squeak", "mallard", "native-only"])
        #expect(s.otherSessions.map(\.title) == ["c", "b"])
    }

    @Test func nothingIsLost() {
        let now = Date(timeIntervalSince1970: 10_000)
        let sessions = (0..<6).map { chat("s\($0)", provider: $0 % 2 == 0 ? "conductor" : "codex-terminal", repo: "r\($0)", cwd: "/r/r\($0)", at: 9_000 + Double($0)) }
        let tree = SidebarTreeBuilder.build(sessions, now: now)
        let s = SidebarSections.split(tree, nativeNames: [])
        let total = s.projects.reduce(0) { $0 + $1.chatCount } + s.otherSessions.count
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
