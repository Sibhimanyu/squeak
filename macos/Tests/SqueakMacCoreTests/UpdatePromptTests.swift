import Testing
@testable import SqueakMacCore

@Suite struct UpdatePromptTests {
    @Test func noUpdateShowsNothing() {
        #expect(UpdatePrompt.mode(available: nil, dismissed: nil, installed: "2.0") == .none)
        #expect(UpdatePrompt.mode(available: "2.0", dismissed: nil, installed: "2.0") == .none)
    }
    @Test func offeredShowsRow() {
        #expect(UpdatePrompt.mode(available: "2.1", dismissed: nil, installed: "2.0") == .row)
    }
    @Test func laterShowsDot() {
        #expect(UpdatePrompt.mode(available: "2.1", dismissed: "2.1", installed: "2.0") == .dot)
    }
    @Test func newerVersionBringsRowBack() {
        #expect(UpdatePrompt.mode(available: "2.2", dismissed: "2.1", installed: "2.0") == .row)
    }
}
