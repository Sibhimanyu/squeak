import Foundation
import Testing
@testable import SqueakMacCore

/// ⌘J, the rail's Terminal icon and the palette's "Toggle terminal" all answer through `TerminalToggle`.
@Suite struct TerminalToggleTests {
    let disk: (String) -> Bool = { ["/p/repo", "/p/repo/duck1"].contains($0) }

    // The Pond's Dashboard and Room (no Duck open): the Pond's own folder.
    @Test func pondPageOpensInThePondFolder() {
        let page = TerminalToggle.Page.pond(paneKey: "pond:a", folder: "/p/repo/")
        #expect(TerminalToggle.decide(page: page, shownFor: nil, isDirectory: disk) == .open(paneKey: "pond:a", folder: "/p/repo"))
    }

    @Test func pondPageClosesWhenItsTerminalIsShowing() {
        let page = TerminalToggle.Page.pond(paneKey: "pond:a", folder: "/p/repo")
        #expect(TerminalToggle.decide(page: page, shownFor: "pond:a", isDirectory: disk) == .close)
    }

    // The pane left open on another page does not make this page's ⌘J a close.
    @Test func aPaneOpenForAnotherPageStillOpensHere() {
        let page = TerminalToggle.Page.pond(paneKey: "pond:a", folder: "/p/repo")
        #expect(TerminalToggle.decide(page: page, shownFor: "duck:d", isDirectory: disk) == .open(paneKey: "pond:a", folder: "/p/repo"))
    }

    @Test func pondWithNoFolderOnThisMacStillOpensAndSaysSo() {
        let page = TerminalToggle.Page.pond(paneKey: "pond:a", folder: "/gone")
        #expect(TerminalToggle.decide(page: page, shownFor: nil, isDirectory: disk) == .open(paneKey: "pond:a", folder: nil))
    }

    // An open Duck chat: the Duck's folder.
    @Test func duckOpensInItsOwnFolder() {
        let page = TerminalToggle.Page.duck(paneKey: "duck:d", cwd: "/p/repo/duck1", pondFolder: "/p/repo")
        #expect(TerminalToggle.decide(page: page, shownFor: nil, isDirectory: disk) == .open(paneKey: "duck:d", folder: "/p/repo/duck1"))
    }

    @Test func duckClosesWhenItsTerminalIsShowing() {
        let page = TerminalToggle.Page.duck(paneKey: "duck:d", cwd: "/p/repo/duck1", pondFolder: "/p/repo")
        #expect(TerminalToggle.decide(page: page, shownFor: "duck:d", isDirectory: disk) == .close)
    }

    // A Pond-wide Duck (no folder of its own), or one whose folder is gone, runs in the Pond's folder.
    @Test func duckWithoutAFolderUsesThePondFolder() {
        let page = TerminalToggle.Page.duck(paneKey: "duck:d", cwd: nil, pondFolder: "/p/repo")
        #expect(TerminalToggle.decide(page: page, shownFor: nil, isDirectory: disk) == .open(paneKey: "duck:d", folder: "/p/repo"))
    }

    @Test func duckWhoseFolderIsGoneUsesThePondFolder() {
        let page = TerminalToggle.Page.duck(paneKey: "duck:d", cwd: "/gone", pondFolder: "/p/repo")
        #expect(TerminalToggle.folder(page: page, isDirectory: disk) == "/p/repo")
    }

    @Test func duckAndPondBothWithoutAFolderStillOpens() {
        let page = TerminalToggle.Page.duck(paneKey: "duck:d", cwd: "", pondFolder: nil)
        #expect(TerminalToggle.decide(page: page, shownFor: nil, isDirectory: disk) == .open(paneKey: "duck:d", folder: nil))
    }

    // The New duck page is a Pond page: the Pond's folder, whatever Duck was open before it.
    @Test func newDuckPageIsAPondPage() {
        let page = TerminalToggle.Page.pond(paneKey: "pond:a", folder: "/p/repo")
        #expect(TerminalToggle.folder(page: page, isDirectory: disk) == "/p/repo")
    }

    // Pages with no work pane (classic layout, global Dashboard, Settings) keep the dock's behaviour.
    @Test func pageWithoutAWorkPaneIsClassic() {
        #expect(TerminalToggle.decide(page: .none, shownFor: nil, isDirectory: disk) == .classic)
        #expect(TerminalToggle.decide(page: .none, shownFor: "pond:a", isDirectory: disk) == .classic)
    }

    // Open then close is a round trip on the real pane state.
    @Test func toggleTwiceOpensThenCloses() {
        var pane = WorkPane()
        let page = TerminalToggle.Page.pond(paneKey: "pond:a", folder: "/p/repo")
        pane.switched(to: "pond:a")
        func press() {
            switch TerminalToggle.decide(page: page, shownFor: pane.shown == nil ? nil : pane.current, isDirectory: disk) {
            case .close: pane.close()
            case .open(let key, _): pane.open(.terminal, duck: key)
            case .classic: break
            }
        }
        press()
        #expect(pane.shown == .terminal)
        press()
        #expect(pane.shown == nil)
    }
}
