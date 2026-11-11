import Testing
@testable import SqueakMacCore

@Suite struct ChatTabWidthTests {
    @Test func fewTabsCapAtMax() { #expect(ChatTabWidth.width(count: 2, available: 1000) == 260) }
    @Test func manyTabsShrinkEvenly() { #expect(ChatTabWidth.width(count: 5, available: 800) == 160) }
    @Test func neverBelowMin() { #expect(ChatTabWidth.width(count: 30, available: 800) == 120) }
    @Test func noTabsOrSpace() {
        #expect(ChatTabWidth.width(count: 0, available: 800) == 260)
        #expect(ChatTabWidth.width(count: 3, available: 0) == 260)
    }
}
