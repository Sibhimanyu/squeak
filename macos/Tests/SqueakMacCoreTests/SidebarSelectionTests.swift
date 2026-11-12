import Testing

@testable import SqueakMacCore

@Suite struct SidebarSelectionTests {
    @Test func aStreamLooksSelectedOnlyWhileItsChatIsOnScreen() {
        #expect(SidebarSelection.streamSelected(containsOpenChat: true, pageShowing: false))
        #expect(!SidebarSelection.streamSelected(containsOpenChat: true, pageShowing: true))
        #expect(!SidebarSelection.streamSelected(containsOpenChat: false, pageShowing: false))
    }
}
