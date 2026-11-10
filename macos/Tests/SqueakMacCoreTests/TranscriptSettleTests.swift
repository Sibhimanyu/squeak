import Testing
@testable import SqueakMacCore

@Suite struct TranscriptSettleTests {
    @Test func waitsUntilMeasuredAndRowsPresent() {
        #expect(TranscriptSettle.next(viewportMeasured: false, rowCount: 5, atBottom: false, elapsed: 5, retries: 0) == .wait)
        #expect(TranscriptSettle.next(viewportMeasured: true, rowCount: 0, atBottom: false, elapsed: 5, retries: 0) == .wait)
    }

    @Test func doneAtBottomAndWaitsBeforeFallback() {
        #expect(TranscriptSettle.next(viewportMeasured: true, rowCount: 5, atBottom: true, elapsed: 0, retries: 0) == .done)
        #expect(TranscriptSettle.next(viewportMeasured: true, rowCount: 5, atBottom: false, elapsed: 0.1, retries: 0) == .wait)
    }

    @Test func tallRowsFallBackThenGiveUpBounded() {
        // ~300 tall rows whose sentinel never appears: fallback is chosen, retries are bounded.
        var retries = 0
        var actions: [TranscriptSettle.Action] = []
        for tick in 0..<20 {
            let a = TranscriptSettle.next(viewportMeasured: true, rowCount: 300, atBottom: false, elapsed: Double(tick) * 0.1, retries: retries)
            actions.append(a)
            if a == .scrollToLastRow { retries += 1 }
            if a == .giveUp { break }
        }
        #expect(actions.filter { $0 == .scrollToLastRow }.count == TranscriptSettle.maxRetries)
        #expect(actions.last == .giveUp)
    }

    @Test func anchorClearedWhenMissing() {
        #expect(TranscriptSettle.anchorToKeep("a", rowIDs: ["a", "b"]) == "a")
        #expect(TranscriptSettle.anchorToKeep("x", rowIDs: ["a", "b"]) == nil)
        #expect(TranscriptSettle.anchorToKeep(nil, rowIDs: ["a"]) == nil)
    }

    @Test func animationOnlyForSmallAppend() {
        #expect(TranscriptSettle.shouldAnimate(old: ["a"], new: ["a", "b"]))
        #expect(TranscriptSettle.shouldAnimate(old: ["a"], new: ["a", "b", "c"]))
        #expect(!TranscriptSettle.shouldAnimate(old: ["a"], new: ["a", "b", "c", "d"]))
        #expect(!TranscriptSettle.shouldAnimate(old: [], new: ["a", "b"]))
        #expect(!TranscriptSettle.shouldAnimate(old: ["a", "b"], new: ["x", "y", "z"]))
        #expect(!TranscriptSettle.shouldAnimate(old: ["a", "b"], new: ["a", "b"]))
    }
}
