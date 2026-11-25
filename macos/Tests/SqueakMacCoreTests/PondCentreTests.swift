import Testing
@testable import SqueakMacCore

@Suite struct PondCentreTests {
    let notebook = TabItem(.notebook, "n1")

    @Test func roomWhileItemSelectedThenDashboardThenDuckThenEscThenSwipeThenDeepLink() {
        var c = PondCentre(page: .dashboard, duck: nil, item: notebook)
        #expect(c.shows == .item(notebook)); #expect(c.switchSelection == nil)

        c.switchTo(.room)
        #expect(c.shows == .page(.room)); #expect(c.switchSelection == .room); #expect(c.stripPage == .room)

        c.switchTo(.dashboard)
        #expect(c.shows == .page(.dashboard)); #expect(c.stripPage == .dashboard)

        c.selectDuck("dhol")
        #expect(c.shows == .duck("dhol")); #expect(c.switchSelection == nil); #expect(c.selectedTab == .duck("dhol"))

        c.escape()   // Duck: Esc goes to the Room
        #expect(c.shows == .page(.room)); #expect(c.stripPage == .room)

        c.swipe(to: .dashboard)
        #expect(c.shows == .page(.dashboard)); #expect(c.switchSelection == .dashboard)

        c.switchTo(.room)
        c.deepLink(duck: "dhol")
        #expect(c.shows == .duck("dhol")); #expect(c.page == .room)
    }

    @Test func switchFromADuckWithRoomSelectedDrawsTheRoomNotAStaleDashboard() {
        // The live bug: the pref said Room, the strip had rested on Dashboard while unmounted.
        var c = PondCentre(page: .dashboard, duck: "dhol")
        c.switchTo(.room)
        #expect(c.stripPage == .room)
        #expect(c.switchSelection == .room)
    }

    @Test func escapeStepsBackOneLayerAtATime() {
        var c = PondCentre(page: .room, duck: "dhol", item: notebook)
        #expect(c.escapeStep == .deselectItem)
        c.escape(); #expect(c.shows == .duck("dhol"))
        c.escape(); #expect(c.shows == .page(.room))
        c.escape(); #expect(c.shows == .page(.dashboard))
        c.escape(); #expect(c.shows == .page(.dashboard)); #expect(c.escapeStep == .nothing)
    }

    @Test func swipeIsIgnoredWhileAnItemOrDuckCoversThePages() {
        var c = PondCentre(page: .dashboard, item: notebook)
        c.swipe(to: .room); #expect(c.page == .dashboard)
        var d = PondCentre(page: .room, duck: "x")
        d.swipe(to: .dashboard); #expect(d.page == .room)
    }

    @Test func itemTabKeepsTheDuckAndPageUnderneath() {
        var c = PondCentre(page: .room, duck: "dhol")
        c.selectItem(notebook)
        #expect(c.shows == .item(notebook))
        c.escape()
        #expect(c.shows == .duck("dhol")); #expect(c.page == .room)
        c.selectItem(.duck("other")); #expect(c.shows == .duck("other"))
    }

    @Test func theSwipeCommitIsOneEventThatOnlySetsThePage() {
        let old = PondCentre(page: .dashboard)
        var next = old
        next.swipe(to: .room)
        #expect(next.effects(from: old) == PondCentre.Effects(page: .room))
    }

    @Test func aDeepLinkOpensTheDuckAndKeepsThePageUnderneath() {
        let old = PondCentre(page: .room, item: notebook)
        var next = old
        next.deepLink(duck: "dhol")
        let e = next.effects(from: old)
        #expect(e.openDuck == "dhol"); #expect(e.deselectItem); #expect(e.page == nil); #expect(!e.leaveDuck)
        // The same Duck again opens nothing new.
        var again = next
        again.deepLink(duck: "dhol")
        #expect(again.effects(from: next).isEmpty)
    }

    @Test func theSwitchFromADuckGoesToThePageAndLeavesTheDuck() {
        let old = PondCentre(page: .dashboard, duck: "dhol")
        var next = old
        next.switchTo(.room)
        #expect(next.effects(from: old) == PondCentre.Effects(page: .room, deselectItem: false, openDuck: nil, leaveDuck: true))
    }

    @Test func escFromADuckIsTheSameEventAsTheSwitchToRoom() {
        let old = PondCentre(page: .dashboard, duck: "dhol")
        var viaEsc = old; viaEsc.escape()
        var viaSwitch = old; viaSwitch.switchTo(.room)
        #expect(viaEsc == viaSwitch)
    }

    @Test func thePondMenuIsNeverStackedWithTheDucksOwnMenu() {
        #expect(PondCentre(page: .room).showsPondMenu)
        #expect(PondCentre(page: .room, item: notebook).showsPondMenu)
        #expect(!PondCentre(page: .room, duck: "dhol").showsPondMenu)
    }

    /// The 2.34.8 bug: "New duck" opened from Pickle's chat still showed Pickle's subheader, branch chip and tab.
    @Test func newDuckPageIsItsOwnStateAndNeverTheLastDucksSubheader() {
        var c = PondCentre(page: .room, duck: "pickle")
        #expect(c.showsDuckSubheader)
        c.startNewDuck()
        #expect(c.shows == .newDuck)
        #expect(!c.showsDuckSubheader)
        #expect(c.selectedTab == nil)
        #expect(c.switchSelection == nil)
        #expect(c.showsPondMenu)
        #expect(c.page == .room)
        // Built from live state where the last Duck is still the selected session: the Duck and item do not leak in.
        let live = PondCentre(page: .room, duck: "pickle", item: notebook, newDuck: true)
        #expect(live.shows == .newDuck); #expect(!live.showsDuckSubheader); #expect(live.selectedTab == nil)
    }

    @Test func newDuckPageLeavesOnTheSwitchADuckTabAnItemAndEsc() {
        var c = PondCentre(page: .dashboard, newDuck: true)
        #expect(c.escapeStep == .closeNewDuck)
        c.escape(); #expect(c.shows == .page(.dashboard))

        c = PondCentre(page: .room, newDuck: true); c.switchTo(.dashboard)
        #expect(c.shows == .page(.dashboard)); #expect(c.switchSelection == .dashboard)

        c = PondCentre(page: .room, newDuck: true); c.selectDuck("dhol")
        #expect(c.shows == .duck("dhol")); #expect(c.showsDuckSubheader)

        c = PondCentre(page: .room, newDuck: true); c.selectItem(notebook)
        #expect(c.shows == .item(notebook))
        // A swipe does not move the strip while the New duck page covers it.
        c = PondCentre(page: .room, newDuck: true); c.swipe(to: .dashboard)
        #expect(c.page == .room)
    }

    @Test func newDuckPageEffects() {
        let old = PondCentre(page: .room, duck: "pickle")
        var c = old; c.startNewDuck()
        #expect(c.effects(from: old).openNewDuck)
        #expect(!c.effects(from: old).leaveDuck)
        var back = c; back.switchTo(.room)
        #expect(back.effects(from: c).closeNewDuck)
    }
}
