import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct WindowLayoutRuleTests {
    @Test func narrowWindowWithAChatCollapsesWithoutTouchingTheSavedChoice() {
        #expect(WindowLayoutRule.sidebarCollapsed(saved: false, chatOpen: true, windowWidth: 1000, expandedByHand: false))
        #expect(!WindowLayoutRule.sidebarCollapsed(saved: false, chatOpen: true, windowWidth: 1200, expandedByHand: false))
    }

    @Test func noChatOrWideWindowShowsTheSavedChoice() {
        #expect(!WindowLayoutRule.sidebarCollapsed(saved: false, chatOpen: false, windowWidth: 900, expandedByHand: false))
        #expect(WindowLayoutRule.sidebarCollapsed(saved: true, chatOpen: false, windowWidth: 1600, expandedByHand: false))
    }

    @Test func widenedByHandStaysOpenWhileNarrow() {
        #expect(!WindowLayoutRule.sidebarCollapsed(saved: false, chatOpen: true, windowWidth: 1000, expandedByHand: true))
        #expect(WindowLayoutRule.sidebarCollapsed(saved: true, chatOpen: true, windowWidth: 1000, expandedByHand: true))
    }

    @Test func listHidesOnlyWithAChatOpen() {
        #expect(WindowLayoutRule.listHidden(saved: true, chatOpen: true))
        #expect(!WindowLayoutRule.listHidden(saved: true, chatOpen: false))
        #expect(!WindowLayoutRule.listHidden(saved: false, chatOpen: true))
    }
}
