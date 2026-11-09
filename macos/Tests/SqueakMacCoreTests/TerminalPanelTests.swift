import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct TerminalPanelTests {
    // MARK: sizing
    @Test func sizingClampsToMinAndSixtyPercent() {
        #expect(TerminalPanelSizing.clamp(50, column: 800) == 120)
        #expect(TerminalPanelSizing.clamp(700, column: 800) == 480)
        #expect(TerminalPanelSizing.clamp(300, column: 800) == 300)
        #expect(TerminalPanelSizing.clamp(.nan, column: 800) == TerminalPanelSizing.defaultHeight)
        #expect(TerminalPanelSizing.clamp(0, column: 800) == TerminalPanelSizing.defaultHeight)
        // A tiny column never pushes the limit under the minimum.
        #expect(TerminalPanelSizing.limit(column: 100) == 120)
        #expect(TerminalPanelSizing.limit(column: 0) == 120)
    }

    @Test func draggingUpGrowsFromWhereItStarted() {
        #expect(TerminalPanelSizing.dragged(start: 240, translation: -60, column: 800) == 300)
        #expect(TerminalPanelSizing.dragged(start: 240, translation: 500, column: 800) == 120)
        #expect(TerminalPanelSizing.dragged(start: 240, translation: -900, column: 800) == 480)
    }

    // MARK: workspace folder
    @Test func availabilityNeedsAFolderOnDisk() {
        let dirs: Set<String> = ["/work/mallard"]
        let isDir: (String) -> Bool = { dirs.contains($0) }
        #expect(TerminalWorkspace.availability(cwd: "/work/mallard/", isDirectory: isDir) == .available(folder: "/work/mallard"))
        #expect(TerminalWorkspace.availability(cwd: nil, isDirectory: isDir) == .unavailable(reason: TerminalWorkspace.noFolder))
        #expect(TerminalWorkspace.availability(cwd: "  ", isDirectory: isDir) == .unavailable(reason: TerminalWorkspace.noFolder))
        #expect(TerminalWorkspace.availability(cwd: "relative/dir", isDirectory: isDir) == .unavailable(reason: TerminalWorkspace.noFolder))
        #expect(TerminalWorkspace.availability(cwd: "/work/gone", isDirectory: isDir) == .unavailable(reason: TerminalWorkspace.missingFolder))
        #expect(TerminalWorkspace.key("/a/b/../c/") == "/a/c")
    }

    // MARK: registry
    @Test func oneTerminalPerWorkspaceKeptAcrossChats() {
        var r = TerminalRegistry()
        let a = r.ensure("/w/a")
        let again = r.ensure("/w/a")
        #expect(again == a)  // another chat in the same workspace: same shell
        let b = r.ensure("/w/b")
        #expect(b.id != a.id)
        #expect(r.tabs("/w/a") == [a])
        #expect(r.allTabs.count == 2)
    }

    @Test func tabsAddSelectAndCloseWithStableNumbers() {
        var r = TerminalRegistry()
        let t1 = r.ensure("/w/a")
        let t2 = r.add("/w/a")
        let t3 = r.add("/w/a")
        let nums: [Int] = [t1.number, t2.number, t3.number]
        #expect(nums == [1, 2, 3])
        #expect(r.selected("/w/a") == t3)
        let closed2 = r.close("/w/a", t2.id)
        #expect(closed2)
        let t4 = r.add("/w/a")
        #expect(t4.number == 4)  // numbers are not reused
        r.select("/w/a", t1.id)
        #expect(r.neighbour("/w/a", forward: false) == t4.id)
        #expect(r.neighbour("/w/a", forward: true) == t3.id)
        // Closing the selected tab shows its left neighbour.
        r.select("/w/a", t3.id)
        r.close("/w/a", t3.id)
        #expect(r.selected("/w/a") == t1)
        r.select("/w/a", UUID())  // unknown id: ignored
        #expect(r.selected("/w/a") == t1)
    }

    @Test func closingTheLastTabEmptiesTheWorkspace() {
        var r = TerminalRegistry()
        let t = r.ensure("/w/a")
        let closed = r.close("/w/a", t.id)
        #expect(closed)
        #expect(r.tabs("/w/a").isEmpty && r.selected("/w/a") == nil)
        let closedAgain = r.close("/w/a", t.id)
        #expect(!closedAgain)
        let fresh = r.ensure("/w/a")
        #expect(fresh.number == 1)  // a fresh shell starts over
    }

    // MARK: shell
    @Test func launchUsesLoginShellWithTermSet() {
        let l = TerminalShell.launch(environment: ["SHELL": "/opt/homebrew/bin/fish", "TERM": "dumb"], isExecutable: { $0 == "/opt/homebrew/bin/fish" })
        #expect(l.executable == "/opt/homebrew/bin/fish" && l.args == ["-l"] && l.name == "fish")
        #expect(l.environment.contains("TERM=xterm-256color") && !l.environment.contains("TERM=dumb"))
        #expect(l.environment.contains("LANG=en_US.UTF-8"))
    }

    @Test func launchFallsBackToZsh() {
        for env in [[:], ["SHELL": "relative/sh"], ["SHELL": "/no/such/shell"]] as [[String: String]] {
            #expect(TerminalShell.launch(environment: env, isExecutable: { _ in false }).executable == "/bin/zsh")
        }
    }

    @Test func closeAsksOnlyForAForegroundProcessOtherThanTheShell() {
        #expect(TerminalShell.closeDecision(shellPid: 100, foregroundGroup: 100) == .closeNow)
        #expect(TerminalShell.closeDecision(shellPid: 100, foregroundGroup: 250) == .confirm)
        #expect(TerminalShell.closeDecision(shellPid: 100, foregroundGroup: nil) == .closeNow)
        #expect(TerminalShell.closeDecision(shellPid: 100, foregroundGroup: -1) == .closeNow)
        #expect(TerminalShell.closeDecision(shellPid: 0, foregroundGroup: 5) == .closeNow)
    }

    // MARK: palette
    private func luminance(_ hex: UInt32) -> Double {
        func c(_ v: UInt32) -> Double { let x = Double(v) / 255; return x <= 0.03928 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4) }
        return 0.2126 * c((hex >> 16) & 255) + 0.7152 * c((hex >> 8) & 255) + 0.0722 * c(hex & 255)
    }
    private func contrast(_ a: UInt32, _ b: UInt32) -> Double {
        let (x, y) = (luminance(a), luminance(b)); return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }

    @Test func paletteIsReadableOnItsGround() {
        for p in [Tokens.Terminal.dark, Tokens.Terminal.light] {
            #expect(p.ansi.count == 16)
            #expect(contrast(p.foreground, p.background) >= 7)
            for (i, c) in p.ansi.enumerated() where i != 0 { #expect(contrast(c, p.background) >= 4.5, "ansi \(i)") }
            // Black is a ground for TUIs, only told apart from the terminal's.
            #expect(contrast(p.ansi[0], p.background) >= 1.2)
            #expect(contrast(p.foreground, p.selection) >= 4.5)
        }
        #expect(Tokens.Terminal.dark.background == Tokens.Dark.bg && Tokens.Terminal.light.background == Tokens.Light.bg)
    }
}
