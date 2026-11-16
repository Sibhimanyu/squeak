import Testing
@testable import SqueakMacCore

@Suite struct TabSlotTests {
    @Test func workingShowsGlyphUntilHovered() {
        #expect(TabSlotContent.of(.working, hovered: false) == .init(close: false, workingGlyph: true, warning: false))
        #expect(TabSlotContent.of(.working, hovered: true) == .init(close: true, workingGlyph: false, warning: false))
    }
    @Test func needsYouShowsWarningUntilHovered() {
        #expect(TabSlotContent.of(.needsYou, hovered: false) == .init(close: false, workingGlyph: false, warning: true))
        #expect(TabSlotContent.of(.needsYou, hovered: true).close)
    }
    @Test func idleIsEmptyUntilHovered() {
        #expect(TabSlotContent.of(.idle, hovered: false) == .init(close: false, workingGlyph: false, warning: false))
        #expect(TabSlotContent.of(.idle, hovered: true) == .init(close: true, workingGlyph: false, warning: false))
    }
    @Test func markMapsToActivity() {
        #expect(TabSlotContent.activity(of: .working) == .working)
        #expect(TabSlotContent.activity(of: .waiting) == .needsYou)
        #expect(TabSlotContent.activity(of: .failed) == .idle)
        #expect(TabSlotContent.activity(of: .unread) == .idle)
        #expect(TabSlotContent.activity(of: nil) == .idle)
    }
}
