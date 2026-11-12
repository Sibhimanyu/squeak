import Testing
@testable import SqueakMacCore

@Suite struct ContextPopoverTests {
    @Test func formatsUsageWindowAndPercent() {
        let p = ContextFormat.Popover.make(tokens: 142_000, limit: 1_000_000, percent: nil, canCompact: true, working: false)
        #expect(p.usage == "142k / 1M")
        #expect(p.percentText == "14.2%")
        #expect(p.windowLine == "Window: 1M tokens")
        #expect(p.level == .normal)
        #expect(p.compact == .ready)
    }

    @Test func workingDisablesCompactWithAReason() {
        let p = ContextFormat.Popover.make(tokens: 190_000, limit: 200_000, percent: nil, canCompact: true, working: true)
        #expect(p.compact == .disabled(ContextFormat.Popover.workingReason))
        #expect(p.level == .danger)
    }

    @Test func nonNativeChatsOfferNoCompact() {
        let p = ContextFormat.Popover.make(tokens: nil, limit: nil, percent: 42, canCompact: false, working: false)
        #expect(p.compact == nil)
        #expect(p.usage == nil && p.windowLine == nil)
        #expect(p.percentText == "42.0%")
    }

    @Test func tokensWithoutAWindowSaysUsed() {
        let p = ContextFormat.Popover.make(tokens: 5_000, limit: nil, percent: nil, canCompact: false, working: false)
        #expect(p.usage == "5k used")
        #expect(p.percentText == nil)
        #expect(p.fraction == 0)
    }
}
