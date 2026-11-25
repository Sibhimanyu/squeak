import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct RailToolTests {
    @Test func sixToolsInOrderAndTasksIsHeldBack() {
        #expect(RailTool.allCases == [.changes, .files, .artifacts, .tasks, .notebook, .terminal])
        #expect(RailTool.shown == [.changes, .files, .artifacts, .notebook, .terminal])
    }

    @Test func listsOpenPopoversNotebookATabAndTerminalThePane() {
        for tool in [RailTool.changes, .files, .artifacts, .tasks] { #expect(tool.opens == .popover) }
        #expect(RailTool.notebook.opens == .tab)
        #expect(RailTool.terminal.opens == .pane)
    }

    @Test func allSixIconsFitTheSmallestWindow() {
        #expect(RailMetrics.fits(icons: RailTool.allCases.count, windowHeight: 620))
        #expect(RailMetrics.height(icons: 0) == 0)
        #expect(RailMetrics.height(icons: 6) == 8 + 240 + 30)
    }
}

@Suite struct RailListsTests {
    private func session(_ id: String, duck: String?, ago: TimeInterval) -> HostSession {
        var s = HostSession(key: SessionKey(provider: "squeak", hostSessionId: id), lastActivityAt: Date(timeIntervalSince1970: 1000 - ago))
        s.duckId = duck
        return s
    }

    private let json = #"""
    {"projectId":"p1",
     "main":{"branch":"main","files":[{"path":"m.txt","status":"M","added":1,"removed":0}],"totals":{"added":1,"removed":0,"files":1}},
     "ducks":[
       {"duckId":"d1","duckName":"Pip","duty":"on","branch":"sq/pip","truncated":true,"totals":{"added":9,"removed":0,"files":5},
        "files":[{"path":"a.txt","status":"M","added":1,"removed":0},{"path":"b.txt","status":"A","added":2,"removed":0}]},
       {"duckId":"d2","duckName":"Moss","duty":"on","branch":"sq/moss","files":[],"totals":{"added":0,"removed":0,"files":0}},
       {"duckId":"d3","duckName":"Ivy","duty":"off","branch":"","files":[{"path":"c.txt"}],"totals":{"added":0,"removed":0,"files":1}}],
     "ducksTruncated":false}
    """#

    private func changes() throws -> HostPondChanges { try JSONDecoder().decode(HostPondChanges.self, from: Data(json.utf8)) }

    @Test func pondListGroupsByDuckThenMainAndSkipsDucksWithNothing() throws {
        let sessions = [session("old", duck: "d1", ago: 500), session("new", duck: "d1", ago: 5), session("x", duck: "d3", ago: 1)]
        let sections = RailChanges.pondSections(try changes(), sessions: sessions, mainSessionKey: "squeak:main")
        #expect(sections.map(\.title) == ["Pip", "Ivy", "Main"])
        #expect(sections[0].branch == "sq/pip" && sections[0].hidden == 3 && sections[0].rows.map(\.path) == ["a.txt", "b.txt"])
        #expect(sections[0].sessionKey == SessionKey(provider: "squeak", hostSessionId: "new").stringValue)
        #expect(sections[1].branch == nil)
        #expect(sections[2].sessionKey == "squeak:main" && !sections[2].isDuck)
        #expect(RailChanges.total(sections) == 5 + 1 + 1)
    }

    @Test func reviewAllNamesTheDuckAndNeedsAChatAndFiles() throws {
        let sections = RailChanges.pondSections(try changes(), sessions: [session("s", duck: "d1", ago: 1)], mainSessionKey: nil)
        #expect(sections[0].reviewAllLabel == "Review all from Pip")
        #expect(sections[1].reviewAllLabel == nil)
        #expect(sections[2].reviewAllLabel == nil)
    }

    @Test func aDucksOwnListHasOnlyItsFiles() {
        let files = [DaemonChanges.File(path: "a.txt", status: "A", added: 3, removed: 1)]
        let list = RailChanges.duckSection(name: "Pip", duckId: "d1", branch: "sq/pip", sessionKey: "k", files: files)
        #expect(list.count == 1 && list[0].reviewAllLabel == "Review all from Pip")
        #expect(list[0].rows == [RailChangeRow(path: "a.txt", status: "A", added: 3, removed: 1)])
        #expect(RailChanges.duckSection(name: "Pip", duckId: "d1", branch: nil, sessionKey: "k", files: []).isEmpty)
        #expect(RailChanges.emptyLine(isPond: true) != RailChanges.emptyLine(isPond: false))
    }

    @Test func artifactsPutTheCurrentDucksFirst() {
        let t = Date(timeIntervalSince1970: 1000)
        let items = [
            ArtifactItem(path: "/a/new.html", duckId: "d2", duckName: "Moss", modifiedAt: t.addingTimeInterval(100)),
            ArtifactItem(path: "/a/mine.html", duckId: "d1", duckName: "Pip", modifiedAt: t),
            ArtifactItem(path: "/a/main.pdf", modifiedAt: t.addingTimeInterval(50)),
        ]
        #expect(RailArtifacts.groups(items, currentDuckId: nil).map(\.title) == ["Moss", "Main", "Pip"])
        #expect(RailArtifacts.groups(items, currentDuckId: "d1").map(\.title) == ["Pip", "Moss", "Main"])
        #expect(RailArtifacts.groups(items, currentDuckId: "gone").map(\.title) == ["Moss", "Main", "Pip"])
        #expect(RailArtifacts.groups(items, currentDuckId: "d1", query: "main").map(\.title) == ["Main"])
    }

    @Test func recentFilesMoveToTheFrontStayWithinTheCapAndFillFromOpenTabs() {
        var r = RailRecentFiles()
        for i in 0..<12 { r.note("f\(i)") }
        r.note("f5")
        #expect(r.paths.count == RailRecentFiles.cap && r.paths.first == "f5")
        #expect(r.paths.filter { $0 == "f5" }.count == 1)
        var fresh = RailRecentFiles()
        fresh.note("b")
        fresh.note("")
        #expect(fresh.list(openTabs: ["a", "b", "c"]) == ["b", "c", "a"])
    }
}
