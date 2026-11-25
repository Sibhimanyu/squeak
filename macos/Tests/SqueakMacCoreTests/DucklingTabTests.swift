import Foundation
import Testing
@testable import SqueakMacCore

/// A Duckling opens as an item tab right after its parent Duck's tab (the live bug: it replaced the Duck's chat in the centre
/// with no tab and no way back).
@Suite struct DucklingTabTests {
    private let pond = "project-1"
    private let a1 = TabItem.duckling(session: "chat-a", task: "t1", parentDuck: "a")
    private let a2 = TabItem.duckling(session: "chat-a", task: "t2", parentDuck: "a")
    private let b1 = TabItem.duckling(session: "chat-b", task: "t1", parentDuck: "b")
    private let notebook = TabItem.notebook

    private func strip(items: [TabItem], current: TabItem? = nil) -> PondWorkspaceStrip {
        let roster = RoomRoster.roster([
            PondDuck(id: "a", name: "Ada", currentSessionId: "s-a"),
            PondDuck(id: "b", name: "Bo", currentSessionId: "s-b")
        ])
        return PondWorkspaceStrip(roster: roster, place: .chat(sessionId: "s-a", duckId: "a"), items: items, current: current)
    }

    @Test func aDucklingIsAnItemTabWithItsSessionTaskAndParent() {
        #expect(a1.kind == .duckling)
        #expect(a1.isPondItem)
        #expect(a1.ducklingSource?.session == "chat-a")
        #expect(a1.ducklingSource?.task == "t1")
        #expect(a1.parentDuck == "a")
        #expect(a1 != a2)
        #expect(a1 != TabItem.duckling(session: "chat-b", task: "t1", parentDuck: "b"))
    }

    @Test func openingOneAddsATabSelectsItAndOpeningItAgainAddsNothing() {
        var store = TabStore()
        store.openPondItem(a1, in: pond)
        store.openPondItem(a1, in: pond)
        #expect(store.pondItems(pond) == [a1])
        #expect(store.currentPondItem(pond) == a1)
    }

    @Test func theStripDrawsItRightAfterItsParentDuckThenOtherItems() {
        let tabs = strip(items: [notebook, b1, a1]).tabs().map(\.item)
        #expect(tabs == [.duck("a"), a1, .duck("b"), b1, notebook])
    }

    @Test func siblingsKeepTheirOrderAfterTheParent() {
        var store = TabStore()
        store.openPondItem(notebook, in: pond)
        store.openPondItem(a1, in: pond)
        store.openPondItem(a2, in: pond)
        #expect(store.pondItems(pond).filter { $0.kind == .duckling } == [a1, a2])
        #expect(strip(items: store.pondItems(pond)).tabs().map(\.item) == [.duck("a"), a1, a2, .duck("b"), notebook])
    }

    @Test func aDucklingWhoseParentIsNotInTheRowStillShowsAfterTheDucks() {
        let orphan = TabItem.duckling(session: "chat-z", task: "t9", parentDuck: "gone")
        #expect(strip(items: [notebook, orphan]).tabs().map(\.item) == [.duck("a"), .duck("b"), orphan, notebook])
    }

    @Test func thePillSaysTheTaskAndTheParentWorkingWithTimeThenDone() {
        let start = Date(timeIntervalSince1970: 1_000)
        let running = Duckling(id: "t1", title: "Review the diff", status: .running, startedAt: start)
        var tab = strip(items: [a1]).tabs(ducklings: [a1: running], now: start.addingTimeInterval(38))[1]
        #expect(tab.title == "Review the diff")
        #expect(tab.status == "Ada \u{00B7} Working \u{00B7} 38s")
        #expect(tab.closable); #expect(tab.duck == nil)
        let done = Duckling(id: "t1", title: "Review the diff", status: .done, startedAt: start, endedAt: start.addingTimeInterval(50))
        tab = strip(items: [a1]).tabs(ducklings: [a1: done], now: start.addingTimeInterval(500))[1]
        #expect(tab.status == "Ada \u{00B7} Done")
        // The host forgot it: the tab stays and says Done; it never closes itself.
        tab = strip(items: [a1]).tabs(ducklings: [:])[1]
        #expect(tab.title == "Duckling"); #expect(tab.status == "Ada \u{00B7} Done")
    }

    @Test func stepsVisitDucklingsInStripOrder() {
        let s = strip(items: [a1], current: a1)
        #expect(s.step(by: 1) == .duck("b"))
        #expect(s.step(by: -1) == .duck("a"))
    }

    // MARK: Esc, close, selecting the parent

    @Test func escGoesToTheParentDuckNotJustAnyPageUnderneath() {
        var c = PondCentre(page: .room, duck: "other", item: a1)
        #expect(c.escapeStep == .toParentDuck)
        let old = c
        c.escape()
        #expect(c.shows == .duck("a")); #expect(c.item == nil)
        #expect(c.effects(from: old).deselectItem); #expect(c.effects(from: old).openDuck == "a")
        // From the Dashboard (no Duck open) it still lands on the parent.
        var d = PondCentre(page: .dashboard, item: a1)
        d.escape(); #expect(d.shows == .duck("a"))
        // Another item still just steps back.
        #expect(PondCentre(page: .room, item: notebook).escapeStep == .deselectItem)
    }

    @Test func clickingTheParentDuckTabReturnsToItsChat() {
        var c = PondCentre(page: .room, duck: "a", item: a1)
        #expect(c.selectedTab == a1)
        c.selectDuck("a")
        #expect(c.shows == .duck("a")); #expect(c.selectedTab == .duck("a"))
    }

    @Test func closingTheDucklingGoesBackToItsParentNotANeighbour() {
        var store = TabStore()
        store.openPondItem(notebook, in: pond)
        store.openPondItem(a1, in: pond)
        store.deselectPondItem(in: pond)
        store.openPondItem(b1, in: pond)
        store.openPondItem(a1, in: pond)
        #expect(store.currentPondItem(pond) == a1)
        let closed = store.closeCurrentPondItem(in: pond)
        #expect(closed)
        #expect(store.currentPondItem(pond) == nil)
        #expect(!store.pondItems(pond).contains(a1)); #expect(store.pondItems(pond).contains(b1))
        // Closing one that is not current leaves the current alone.
        store.openPondItem(a2, in: pond)
        store.closePondItem(b1, in: pond)
        #expect(store.currentPondItem(pond) == a2)
    }

    // MARK: Persistence

    @Test func theTabPersistsPerPondAndNeverClosesItself() {
        let name = "ducklingtab.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        var store = TabStore()
        store.openPondItem(a1, in: pond)
        store.openPondItem(b1, in: "project-2")
        store.save(pond: pond, to: defaults); store.save(pond: "project-2", to: defaults)
        var restored = TabStore(restoring: defaults)
        #expect(restored.pondItems(pond) == [a1]); #expect(restored.currentPondItem(pond) == a1)
        #expect(restored.pondItems("project-2") == [b1])
        // Things that go away prune the classic strip only: a finished Duckling's tab stays.
        restored.prune(exists: { _ in false })
        #expect(restored.pondItems(pond) == [a1])
    }

    @Test func aTabSavedWithoutAParentStillDecodes() throws {
        let old = #"{"kind":"duckling","id":"chat-a\u001Ft1"}"#.data(using: .utf8)!
        let item = try JSONDecoder().decode(TabItem.self, from: old)
        #expect(item.kind == .duckling); #expect(item.parentDuck == nil); #expect(item.ducklingSource?.task == "t1")
        let round = try JSONDecoder().decode(TabItem.self, from: JSONEncoder().encode(a1))
        #expect(round == a1)
        // Without a parent Esc steps back like any item.
        #expect(PondCentre(page: .room, item: item).escapeStep == .deselectItem)
    }
}
