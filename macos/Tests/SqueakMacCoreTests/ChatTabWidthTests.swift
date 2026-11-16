import Testing
@testable import SqueakMacCore

@Suite struct ChatTabWidthTests {
    @Test func fitsMeansNoCap() {
        #expect(ChatTabWidth.cap(naturals: [120, 150, 90], available: 400) == .infinity)
        #expect(ChatTabWidth.cap(naturals: [], available: 400) == .infinity)
        #expect(ChatTabWidth.cap(naturals: [120], available: 0) == .infinity)
    }
    @Test func shortTabsKeepTheirWidthAndLongOnesGiveWay() {
        let naturals = [90.0, 260, 260]
        let cap = ChatTabWidth.cap(naturals: naturals, available: 500)
        #expect(cap >= 204 && cap <= 205)   // 90 + 2 x ~205 = 500: no room left empty
        #expect(naturals.reduce(0) { $0 + min($1, cap) } <= 500)
    }
    @Test func neverBelowTheFloor() {
        #expect(ChatTabWidth.cap(naturals: Array(repeating: 260, count: 30), available: 800) == ChatTabWidth.minWidth)
    }
    @Test func naturalWidthHugsTheTitle() {
        #expect(ChatTabWidth.natural(titleWidth: 30) == ChatTabWidth.chrome + 30)
        #expect(ChatTabWidth.natural(titleWidth: 900) == ChatTabWidth.chrome + ChatTabWidth.maxTitle)
        #expect(ChatTabWidth.chrome == 54)
    }
}

@Suite struct CloseRoutingTests {
    @Test func routes() {
        #expect(CloseRouting.route(mainWindowKey: true, tabClosable: true) == .tab)
        #expect(CloseRouting.route(mainWindowKey: true, tabClosable: false) == .window)
        #expect(CloseRouting.route(mainWindowKey: false, tabClosable: true) == .window)
    }
    @Test func neighbour() {
        #expect(ChatTabs.selectionAfterClosing("b", selected: "b", shown: ["a", "b", "c"]) == "c")
        #expect(ChatTabs.selectionAfterClosing("c", selected: "c", shown: ["a", "b", "c"]) == "b")
        #expect(ChatTabs.selectionAfterClosing("a", selected: "a", shown: ["a"]) == nil)
    }
}
