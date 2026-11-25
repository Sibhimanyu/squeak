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
}
