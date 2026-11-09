import Testing
@testable import SqueakMacCore

@Suite struct InspectorTabTests {
    @Test func aSqueakChatGetsEveryTabInOrder() {
        #expect(InspectorTab.available(native: true).map(\.title) == ["All files", "Changes", "Checks", "Review", "Setup", "Run"])
    }

    @Test func aConductorChatGetsNoWorkspaceTabs() {
        #expect(InspectorTab.available(native: false).map(\.title) == ["All files", "Changes", "Review"])
    }
}
