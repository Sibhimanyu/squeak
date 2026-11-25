import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct PondWorkScopeTests {
    private let scope = PondWorkScope(key: "greenroom", projectId: "p-1", name: "Greenroom", root: "/Users/me/greenroom")

    private func session(_ id: String, cwd: String?, at: TimeInterval) -> HostSession {
        HostSession(key: SessionKey(provider: "squeak", hostSessionId: id), cwd: cwd, lastActivityAt: Date(timeIntervalSince1970: at))
    }

    @Test func paneIsKeyedByProjectIdNotName() {
        #expect(scope.paneKey == "pond:p-1")
        var renamed = scope
        renamed.name = "Other"
        #expect(renamed.paneKey == scope.paneKey)
        #expect(scope.paneKey != WorkPaneMetrics.duckKey(duckId: "p-1", sessionKey: "x"))
    }

    @Test func changesComeFromARealSessionInThePondFolderOnly() {
        let main = session("main", cwd: "/Users/me/greenroom/", at: 5)
        let newer = session("newer", cwd: "/Users/me/greenroom", at: 9)
        let branch = session("branch", cwd: "/Users/me/greenroom-wt/sage", at: 99)
        #expect(scope.changesSession(in: [main, branch, newer])?.key.hostSessionId == "newer")
        #expect(scope.changesSession(in: [branch]) == nil)
        #expect(scope.changesSession(in: []) == nil)
    }

    @Test func openRequestsForOtherFoldersAreNotThePondsOwn() {
        #expect(scope.owns(root: nil))
        #expect(scope.owns(root: "/Users/me/greenroom/"))
        #expect(!scope.owns(root: "/Users/me/elsewhere"))
    }

    @Test func pondPaneShowsOnBothPondPagesInTheNewLayoutOnly() {
        #expect(WorkPaneScopeRule.pondScope(isNewLayout: true, onPondPage: true, hasLocalFolder: true))
        #expect(!WorkPaneScopeRule.pondScope(isNewLayout: false, onPondPage: true, hasLocalFolder: true))
        #expect(!WorkPaneScopeRule.pondScope(isNewLayout: true, onPondPage: false, hasLocalFolder: true))
        #expect(!WorkPaneScopeRule.pondScope(isNewLayout: true, onPondPage: true, hasLocalFolder: false))
    }

    @Test func pondPaneRemembersItsViewPerProject() {
        var p = WorkPane()
        p.open(.files, duck: scope.paneKey)
        p.switched(to: "duck:a")
        p.open(.terminal, duck: "duck:a")
        p.switched(to: scope.paneKey)
        #expect(p.memory[scope.paneKey]?.view == .files)
    }
}

@Suite struct PondPageChromeTests {
    @Test func headerAndRowDoNotDependOnThePage() {
        for page in PondPage.allCases { #expect(PondPageChrome.pageHasHeader(page)) }
        #expect(PondPageChrome.headerInset(rowShown: true, sidebarClearance: 80) == 0)
        #expect(PondPageChrome.headerInset(rowShown: false, sidebarClearance: 80) == 80)
    }

    @Test func rowSelectionFollowsThePageAndNothingElse() {
        #expect(PondPageChrome.rowPlace(page: .room) == .room)
        #expect(PondPageChrome.rowPlace(page: .dashboard) == .dashboard)
    }

    @Test func aSwapNeedsARoomAndADifferentPage() {
        #expect(PondPageChrome.swaps(hasRoom: true, from: .dashboard, to: .room))
        #expect(!PondPageChrome.swaps(hasRoom: true, from: .room, to: .room))
        #expect(!PondPageChrome.swaps(hasRoom: false, from: .dashboard, to: .room))
    }
}
