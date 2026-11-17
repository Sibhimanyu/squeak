import XCTest
@testable import SqueakMacCore

private struct SeededRNG: RandomNumberGenerator {
    var state: UInt64
    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
}

final class DockLayoutTests: XCTestCase {
    private func assertInvariant(_ l: DockLayout, _ note: String = "", file: StaticString = #filePath, line: UInt = #line) {
        var all = DockZone.allCases.flatMap { l[$0].panels } + l.hidden
        all.sort { $0.rawValue < $1.rawValue }
        XCTAssertEqual(all, DockPanel.allCases.sorted { $0.rawValue < $1.rawValue }, note, file: file, line: line)
        for z in DockZone.allCases {
            if let s = l[z].selected { XCTAssertTrue(l[z].panels.contains(s), "\(z) \(note)", file: file, line: line) }
            if z != .centre && !l[z].panels.isEmpty { XCTAssertNotNil(l[z].selected, "\(z) \(note)", file: file, line: line) }
        }
    }

    func testStandard() {
        let l = DockLayout.standard
        XCTAssertEqual(l.right.panels, [.thread, .pond, .code]); XCTAssertEqual(l.right.selected, .thread)
        XCTAssertEqual(l.bottom.panels, [.terminal]); XCTAssertTrue(l.bottom.collapsed)
        XCTAssertTrue(l.centre.panels.isEmpty)
        assertInvariant(l)
        XCTAssertEqual(DockPanel.terminal.title, "Terminal")
        XCTAssertEqual(DockPanel.pond.symbol, "person.2")
    }

    func testThreadTabJoinsOldSavesBeforePond() throws {
        // An old save (no thread anywhere) that was the untouched default also gets Thread showing.
        let old = #"{"centre":{"panels":[]},"right":{"panels":["pond","code"],"selected":"pond"},"bottom":{"panels":["terminal"]},"hidden":[]}"#
        let a = try JSONDecoder().decode(DockLayout.self, from: Data(old.utf8))
        XCTAssertEqual(a.right.panels, [.thread, .pond, .code]); XCTAssertEqual(a.right.selected, .thread)
        // A customised arrangement keeps its own selection and order; Thread still arrives before Pond.
        let custom = #"{"centre":{"panels":[]},"right":{"panels":["code","pond"],"selected":"code"},"bottom":{"panels":["terminal"]},"hidden":[]}"#
        let b = try JSONDecoder().decode(DockLayout.self, from: Data(custom.utf8))
        XCTAssertEqual(b.right.panels, [.code, .thread, .pond]); XCTAssertEqual(b.right.selected, .code)
        // Pond was the selection and Code moved away: not the default, so it stays on Pond.
        let moved = #"{"centre":{"panels":[]},"right":{"panels":["pond"],"selected":"pond"},"bottom":{"panels":["terminal","code"]},"hidden":[]}"#
        let c = try JSONDecoder().decode(DockLayout.self, from: Data(moved.utf8))
        XCTAssertEqual(c.right.panels, [.thread, .pond]); XCTAssertEqual(c.right.selected, .pond)
        // A save with no right panels at all does not bring the inspector back: Thread waits in hidden.
        let none = #"{"centre":{"panels":[]},"right":{"panels":[]},"bottom":{"panels":["terminal"]},"hidden":["pond","code"]}"#
        let d = try JSONDecoder().decode(DockLayout.self, from: Data(none.utf8))
        XCTAssertTrue(d.right.panels.isEmpty); XCTAssertTrue(d.hidden.contains(.thread))
        // A save that already knows Thread (even closed) is left alone.
        let closed = #"{"centre":{"panels":[]},"right":{"panels":["pond","code"],"selected":"pond"},"bottom":{"panels":[]},"hidden":["thread","terminal"]}"#
        let e = try JSONDecoder().decode(DockLayout.self, from: Data(closed.utf8))
        XCTAssertEqual(e.right.panels, [.pond, .code]); XCTAssertEqual(e.hidden, [.thread, .terminal])
        for l in [a, b, c, d, e] { assertInvariant(l); XCTAssertEqual(l, l.normalized()) }
    }

    func testPondNeverDocksInTheCentre() {
        var l = DockLayout.standard
        l.move(.pond, to: .centre)
        XCTAssertEqual(l, DockLayout.standard)
        XCTAssertEqual(DockPanel.thread.title, "Thread")
        XCTAssertEqual(DockPanel.allCases.prefix(3), [.thread, .pond, .code])
        for w in DockWorkspaces.builtIns { XCTAssertEqual(w.saved.right.panels.first, .thread, w.name) }
    }

    func testZoneOfAndVisibility() {
        var l = DockLayout.standard
        XCTAssertEqual(l.zone(of: .code), .right)
        XCTAssertTrue(l.isZoneVisible(.centre)); XCTAssertTrue(l.isZoneVisible(.right))
        l.close(.terminal)
        XCTAssertNil(l.zone(of: .terminal)); XCTAssertFalse(l.isZoneVisible(.bottom))
    }

    func testMoveAcrossZonesSelectsAndFixesOldSelection() {
        var l = DockLayout.standard
        l.move(.thread, to: .centre)
        XCTAssertEqual(l.centre.panels, [.thread]); XCTAssertEqual(l.centre.selected, .thread)
        XCTAssertEqual(l.right.panels, [.pond, .code]); XCTAssertEqual(l.right.selected, .pond)
        l.move(.code, to: .bottom, before: .terminal)
        l.move(.pond, to: .bottom)
        XCTAssertEqual(l.bottom.panels, [.code, .terminal, .pond]); XCTAssertEqual(l.bottom.selected, .pond)
        XCTAssertFalse(l.bottom.collapsed)
        XCTAssertTrue(l.right.panels.isEmpty); XCTAssertNil(l.right.selected)
        assertInvariant(l)
    }

    func testMoveFallsToNextThenPrevious() {
        var l = DockLayout(right: DockZoneState(panels: [.pond, .code, .terminal], selected: .code))
        l.move(.code, to: .bottom)
        XCTAssertEqual(l.right.selected, .terminal)
        l = DockLayout(right: DockZoneState(panels: [.pond, .code, .terminal], selected: .terminal))
        l.move(.terminal, to: .bottom)
        XCTAssertEqual(l.right.selected, .code)
    }

    func testReorderWithinZone() {
        var l = DockLayout.standard
        l.move(.code, to: .right, before: .pond)
        XCTAssertEqual(l.right.panels, [.thread, .code, .pond]); XCTAssertEqual(l.right.selected, .code)
        l.move(.code, to: .right)
        XCTAssertEqual(l.right.panels, [.thread, .pond, .code])
        l.move(.code, to: .right, before: .code)
        XCTAssertEqual(l.right.panels, [.thread, .pond, .code])
        assertInvariant(l)
    }

    func testSelectAndSelectChats() {
        var l = DockLayout.standard
        l.select(.code); XCTAssertEqual(l.right.selected, .code)
        l.move(.thread, to: .centre); XCTAssertEqual(l.centre.selected, .thread)
        l.selectChats(); XCTAssertNil(l.centre.selected)
        l.close(.code); l.select(.code)
        XCTAssertNil(l.zone(of: .code))
    }

    func testCloseAndShow() {
        var l = DockLayout.standard
        l.close(.code)
        XCTAssertEqual(l.hidden, [.code]); XCTAssertEqual(l.right.panels, [.thread, .pond])
        l.show(.code)
        XCTAssertEqual(l.right.panels, [.thread, .pond, .code]); XCTAssertEqual(l.right.selected, .code)
        XCTAssertTrue(l.hidden.isEmpty)
        l.select(.pond); l.setCollapsed(true, for: .right)
        l.show(.code)
        XCTAssertFalse(l.right.collapsed); XCTAssertEqual(l.right.selected, .code)
        l.close(.terminal); l.show(.terminal)
        XCTAssertEqual(l.bottom.panels, [.terminal])
        XCTAssertFalse(l.bottom.collapsed)
        assertInvariant(l)
    }

    func testToggle() {
        var l = DockLayout.standard
        l.toggle(.terminal)                       // collapsed: shows
        XCTAssertFalse(l.bottom.collapsed); XCTAssertEqual(l.zone(of: .terminal), .bottom)
        l.toggle(.terminal)                       // showing: closes
        XCTAssertNil(l.zone(of: .terminal))
        l.toggle(.terminal)                       // hidden: back
        XCTAssertEqual(l.zone(of: .terminal), .bottom)
        l.select(.pond); l.toggle(.code)          // visible but unselected: selects
        XCTAssertEqual(l.right.selected, .code)
        l.toggle(.code)
        XCTAssertEqual(l.hidden, [.code])
        assertInvariant(l)
    }

    func testSizeAndCollapse() {
        var l = DockLayout.standard
        l.setSize(100, for: .right); XCTAssertEqual(l.right.size, 280)
        l.setSize(9999, for: .right); XCTAssertEqual(l.right.size, 560)
        l.setSize(10, for: .bottom); XCTAssertEqual(l.bottom.size, 120)
        l.setSize(.nan, for: .bottom); XCTAssertNil(l.bottom.size)
        l.setSize(300, for: .centre); XCTAssertNil(l.centre.size)
        l.setCollapsed(true, for: .centre); XCTAssertFalse(l.centre.collapsed)
        l.setCollapsed(false, for: .bottom); XCTAssertFalse(l.bottom.collapsed)
    }

    func testMigrationCombos() {
        let a = DockLayout.migrated(codeView: true, terminalOpen: false, inspectorOpen: false, inspectorWidth: 0, terminalHeight: 0)
        XCTAssertEqual(a.right.selected, .code); XCTAssertTrue(a.bottom.collapsed)
        XCTAssertTrue(a.right.collapsed); XCTAssertNil(a.right.size); XCTAssertNil(a.bottom.size)
        let b = DockLayout.migrated(codeView: false, terminalOpen: true, inspectorOpen: true, inspectorWidth: 400, terminalHeight: 300)
        XCTAssertEqual(b.right.selected, .thread); XCTAssertFalse(b.bottom.collapsed)
        XCTAssertFalse(b.right.collapsed); XCTAssertEqual(b.right.size, 400); XCTAssertEqual(b.bottom.size, 300)
        let c = DockLayout.migrated(codeView: false, terminalOpen: true, inspectorOpen: true, inspectorWidth: 5000, terminalHeight: 1)
        XCTAssertEqual(c.right.size, 560); XCTAssertEqual(c.bottom.size, 120)
        for l in [a, b, c] { assertInvariant(l); XCTAssertEqual(l, l.normalized()) }
    }

    func testDecodeRepairsDuplicateMissingAndUnknown() throws {
        let json = """
        {"centre":{"panels":["pond","future"],"selected":"future"},
         "right":{"panels":["pond","code"],"selected":"terminal","size":9000},
         "bottom":{"panels":["code"],"collapsed":true},"hidden":["pond","mystery"]}
        """
        let l = try JSONDecoder().decode(DockLayout.self, from: Data(json.utf8))
        // The Pond panel never lives in the centre: an older save with it there gets it back on the right.
        XCTAssertTrue(l.centre.panels.isEmpty); XCTAssertNil(l.centre.selected)
        XCTAssertEqual(l.right.panels, [.thread, .code, .pond]); XCTAssertEqual(l.right.selected, .thread)
        XCTAssertEqual(l.right.size, 560)
        XCTAssertTrue(l.bottom.panels.isEmpty)
        XCTAssertEqual(l.hidden, [.terminal])
        assertInvariant(l)
        let empty = try JSONDecoder().decode(DockLayout.self, from: Data("{}".utf8))
        assertInvariant(empty)
        XCTAssertEqual(Set(empty.hidden), Set(DockPanel.allCases))
    }

    func testRoundTripAndStableEncoding() throws {
        let enc = JSONEncoder(); enc.outputFormatting = [.sortedKeys]
        var l = DockLayout.standard; l.move(.code, to: .centre); l.setSize(400, for: .right)
        let d = try enc.encode(l)
        XCTAssertEqual(try JSONDecoder().decode(DockLayout.self, from: d), l)
        XCTAssertEqual(try enc.encode(l), d)
    }

    func testRandomOperationsKeepInvariant() {
        var rng = SeededRNG(state: 42)
        var l = DockLayout.standard
        for i in 0..<500 {
            let p = DockPanel.allCases.randomElement(using: &rng)!
            let z = DockZone.allCases.randomElement(using: &rng)!
            switch Int.random(in: 0..<9, using: &rng) {
            case 0: l.move(p, to: z, before: Bool.random(using: &rng) ? DockPanel.allCases.randomElement(using: &rng) : nil)
            case 1: l.select(p)
            case 2: l.selectChats()
            case 3: l.close(p)
            case 4: l.show(p)
            case 5: l.toggle(p)
            case 6: l.setSize(Double.random(in: -50...2000, using: &rng), for: z)
            case 7: l.setCollapsed(Bool.random(using: &rng), for: z)
            default: l = l.normalized()
            }
            assertInvariant(l, "op \(i)")
        }
    }

    // MARK: Workspaces

    func testBuiltInsAndInitial() {
        let w = DockWorkspaces()
        XCTAssertEqual(w.workspaces.map(\.id), ["default", "terminal", "review"])
        XCTAssertEqual(w.activeID, "default")
        XCTAssertEqual(w.workspaces[1].saved.centre.selected, .terminal)
        XCTAssertTrue(w.workspaces[1].saved.bottom.panels.isEmpty)
        XCTAssertEqual(w.workspaces[2].saved.centre.selected, .code)
        XCTAssertTrue(w.workspaces[2].saved.bottom.collapsed)
        for ws in w.workspaces { assertInvariant(ws.saved) }
        let m = DockLayout.migrated(codeView: true, terminalOpen: true, inspectorOpen: true, inspectorWidth: 0, terminalHeight: 0)
        let i = DockWorkspaces.initial(migratedFrom: m)
        XCTAssertEqual(i.active.current, m); XCTAssertEqual(i.active.saved, .standard)
    }

    func testBuiltInsSurviveDecode() throws {
        var mine = DockLayout.standard; mine.close(.code)
        let json = """
        {"workspaces":[{"id":"review","name":"X","builtIn":true,"saved":{},"current":\(String(data: try JSONEncoder().encode(mine), encoding: .utf8)!)},
                       {"id":"mine","name":"Mine","builtIn":false,"saved":{},"current":{}}, 7],
         "activeID":"gone"}
        """
        let w = try JSONDecoder().decode(DockWorkspaces.self, from: Data(json.utf8))
        XCTAssertEqual(w.workspaces.map(\.id), ["default", "terminal", "review", "mine"])
        XCTAssertEqual(w.workspaces[2].name, "Review")
        XCTAssertEqual(w.workspaces[2].current, mine)
        XCTAssertEqual(w.workspaces[2].saved, DockWorkspaces.builtIns[2].saved)
        XCTAssertEqual(w.activeID, "default")
        let empty = try JSONDecoder().decode(DockWorkspaces.self, from: Data("{}".utf8))
        XCTAssertEqual(empty.workspaces.count, 3)
    }

    func testUpdateSwitchResetOverwrite() {
        var w = DockWorkspaces()
        var l = DockLayout.standard; l.close(.pond)
        w.update(l)
        XCTAssertEqual(w.active.current, l)
        w.resetActive(); XCTAssertEqual(w.active.current, .standard)
        w.overwriteActive(); XCTAssertEqual(w.active.saved, .standard)   // built-in: refused
        w.update(l)
        w.overwriteActive(); XCTAssertEqual(w.active.saved, .standard)
        w.switchTo(id: "review"); XCTAssertEqual(w.activeID, "review")
        w.switchTo(id: "nope"); XCTAssertEqual(w.activeID, "review")
        w.switchTo(id: "default"); XCTAssertEqual(w.active.current, l)
    }

    func testSaveNewNaming() throws {
        var w = DockWorkspaces()
        XCTAssertNil(w.saveNew(name: "   "))
        var l = DockLayout.standard; l.close(.code)
        w.update(l)
        let id = try XCTUnwrap(w.saveNew(name: "  Mine "))
        XCTAssertEqual(w.activeID, id); XCTAssertEqual(w.active.name, "Mine")
        XCTAssertEqual(w.active.saved, l); XCTAssertEqual(w.active.current, l); XCTAssertFalse(w.active.builtIn)
        XCTAssertEqual(w.workspaces[0].current, l)
        _ = w.saveNew(name: "Mine"); XCTAssertEqual(w.active.name, "Mine 2")
        _ = w.saveNew(name: "Mine"); XCTAssertEqual(w.active.name, "Mine 3")
        _ = w.saveNew(name: "Default"); XCTAssertEqual(w.active.name, "Default 2")
    }

    func testRenameDeleteOverwrite() throws {
        var w = DockWorkspaces()
        let id = try XCTUnwrap(w.saveNew(name: "A"))
        w.rename(id: id, to: " B "); XCTAssertEqual(w.active.name, "B")
        w.rename(id: id, to: "  "); XCTAssertEqual(w.active.name, "B")
        w.rename(id: "default", to: "Z"); XCTAssertEqual(w.workspaces[0].name, "Default")
        var l = DockLayout.standard; l.close(.terminal)
        w.update(l); w.overwriteActive(); XCTAssertEqual(w.active.saved, l)
        w.delete(id: "review"); XCTAssertEqual(w.workspaces.count, 4)
        w.delete(id: id)
        XCTAssertEqual(w.activeID, "default"); XCTAssertEqual(w.workspaces.map(\.id), ["default", "terminal", "review"])
        let other = try XCTUnwrap(w.saveNew(name: "C"))
        w.switchTo(id: "terminal")
        w.delete(id: other); XCTAssertEqual(w.activeID, "terminal")
    }

    func testWorkspacesRoundTrip() throws {
        var w = DockWorkspaces()
        _ = w.saveNew(name: "Mine")
        let d = try JSONEncoder().encode(w)
        XCTAssertEqual(try JSONDecoder().decode(DockWorkspaces.self, from: d), w)
    }
}
