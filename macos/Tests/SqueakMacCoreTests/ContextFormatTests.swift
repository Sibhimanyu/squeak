import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct ContextFormatTests {
    @Test func tokensAreShort() {
        #expect(ContextFormat.tokens(842) == "842")
        #expect(ContextFormat.tokens(142_000) == "142k")
        #expect(ContextFormat.tokens(1_500) == "1.5k")
        #expect(ContextFormat.tokens(1_000_000) == "1M")
        #expect(ContextFormat.tokens(200_000) == "200k")
    }

    @Test func tooltipAndPercent() {
        #expect(ContextFormat.tooltip(tokens: 142_000, limit: 1_000_000)?.hasPrefix("Context: 142k of 1M tokens (14%)") == true)
        #expect(ContextFormat.percent(tokens: nil, limit: 200_000) == nil)
        #expect(ContextFormat.percent(tokens: 10, limit: 0) == nil)
    }

    @Test func thresholds() {
        #expect(ContextFormat.level(79.9) == .normal)
        #expect(ContextFormat.level(80) == .warning)
        #expect(ContextFormat.level(94.9) == .warning)
        #expect(ContextFormat.level(95) == .danger)
        #expect(ContextFormat.level(nil) == .normal)
    }

    @Test func modeChipTooltipAndLabel() {
        #expect(NativeModes.chipTooltip(.skipApprovals, cycles: true) == "Skip approvals · ⇧Tab")
        #expect(NativeModes.chipTooltip(.plan, cycles: false) == "Plan")
        #expect(NativeModes.chipLabel(.skipApprovals) == nil)
        #expect(NativeModes.chipLabel(.ask) == nil)
        #expect(NativeModes.chipLabel(.plan) == "Plan")
    }
}
