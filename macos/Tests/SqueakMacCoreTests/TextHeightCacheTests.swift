import CoreGraphics
import Testing
@testable import SqueakMacCore

/// Clicking a shared (remote) thread crashed: a user bubble inside an unbounded container got an infinite width
/// proposal and `TextHeightCache.Key` trapped converting it to Int (crash report 2026-11-21 18:41).
@Suite struct TextHeightCacheTests {
    @Test func nonFiniteWidthsDoNotTrap() {
        #expect(TextHeightCache.Key(id: "a", content: 1, width: .infinity).width == -1)
        #expect(TextHeightCache.Key(id: "a", content: 1, width: .nan).width == -1)
        #expect(TextHeightCache.Key(id: "a", content: 1, width: 412.6).width == 413)
    }

    @Test func usableWidthFallsBackOnUnboundedProposals() {
        #expect(TextHeightCache.usableWidth(nil, fallback: 640) == 640)
        #expect(TextHeightCache.usableWidth(.infinity, fallback: 640) == 640)
        #expect(TextHeightCache.usableWidth(.nan, fallback: 640) == 640)
        #expect(TextHeightCache.usableWidth(0, fallback: 640) == 640)
        #expect(TextHeightCache.usableWidth(500, fallback: 640) == 500)
    }
}
