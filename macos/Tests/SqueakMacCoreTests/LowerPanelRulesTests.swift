import Testing
@testable import SqueakMacCore

@Suite struct LowerPanelRulesTests {
    @Test func presentInBothModesOnlyWithWorkspace() {
        #expect(LowerPanelRules.isPresent(hasWorkspace: true, codeView: true))
        #expect(LowerPanelRules.isPresent(hasWorkspace: true, codeView: false))
        #expect(!LowerPanelRules.isPresent(hasWorkspace: false, codeView: false))
        #expect(!LowerPanelRules.isPresent(hasWorkspace: false, codeView: true))
    }
    @Test func heights() {
        #expect(LowerPanelRules.frameHeight(collapsed: true, stored: 300, column: 800) == 40)
        #expect(LowerPanelRules.frameHeight(collapsed: false, stored: 0, column: 800) == TerminalPanelSizing.defaultHeight)
        #expect(LowerPanelRules.frameHeight(collapsed: false, stored: 10, column: 800) == TerminalPanelSizing.minHeight)
        #expect(LowerPanelRules.frameHeight(collapsed: false, stored: 9999, column: 800) == 480)
    }
    @Test func expandCollapse() {
        #expect(LowerPanelRules.collapsedAfterTab(true) == false)
        #expect(LowerPanelRules.collapsedAfterChevron(false) == true)
        #expect(LowerPanelRules.collapsedAfterChevron(true) == false)
    }
}
