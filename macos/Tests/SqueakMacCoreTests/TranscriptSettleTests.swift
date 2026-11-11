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

    @Test func tallRowsRetryQuicklyThenSlowlyThenLastResort() {
        var retries = 0
        var actions: [TranscriptSettle.Action] = []
        for tick in 0...120 {
            let a = TranscriptSettle.next(viewportMeasured: true, rowCount: 300, atBottom: false, elapsed: Double(tick) * 0.1, retries: retries)
            actions.append(a)
            if a == .scrollToLastRow { retries += 1 }
            if a == .lastResort { break }
        }
        #expect(!actions.contains(.giveUp))
        #expect(actions.last == .lastResort)
        // Three quick retries, then roughly one per half second until the 10 s cap.
        #expect(retries > TranscriptSettle.maxRetries + 10)
        #expect(retries < 30)
    }

    @Test func slowRetryWaitsBetweenAttempts() {
        let quick = TranscriptSettle.maxRetries
        #expect(TranscriptSettle.next(viewportMeasured: true, rowCount: 5, atBottom: false, elapsed: 0.5, retries: quick) == .wait)
        #expect(TranscriptSettle.next(viewportMeasured: true, rowCount: 5, atBottom: false, elapsed: 0.9, retries: quick) == .scrollToLastRow)
        #expect(TranscriptSettle.next(viewportMeasured: true, rowCount: 5, atBottom: false, elapsed: 5, retries: quick) == .scrollToLastRow)
    }

    @Test func stopsOnceAtBottomEvenLate() {
        #expect(TranscriptSettle.next(viewportMeasured: true, rowCount: 5, atBottom: true, elapsed: 4, retries: 8) == .done)
        #expect(TranscriptSettle.next(viewportMeasured: true, rowCount: 5, atBottom: true, elapsed: 50, retries: 8) == .done)
    }

    @Test func lastResortAfterCapNotBefore() {
        #expect(TranscriptSettle.next(viewportMeasured: true, rowCount: 5, atBottom: false, elapsed: 9.9, retries: 5) == .scrollToLastRow)
        #expect(TranscriptSettle.next(viewportMeasured: true, rowCount: 5, atBottom: false, elapsed: 10, retries: 5) == .lastResort)
    }

    @Test func unmeasuredViewportIsBounded() {
        #expect(TranscriptSettle.next(viewportMeasured: false, rowCount: 5, atBottom: false, elapsed: 0, retries: 0, total: 9) == .wait)
        #expect(TranscriptSettle.next(viewportMeasured: false, rowCount: 5, atBottom: false, elapsed: 0, retries: 0, total: 10) == .giveUp)
        #expect(TranscriptSettle.next(viewportMeasured: true, rowCount: 0, atBottom: false, elapsed: 0, retries: 0, total: 10) == .giveUp)
    }

    @Test func keptAnchorNeverRetries() {
        for elapsed in [0.0, 0.5, 2, 9, 30] {
            #expect(TranscriptSettle.next(viewportMeasured: true, rowCount: 50, atBottom: false, elapsed: elapsed, retries: 4, keepAnchor: true) == .wait)
        }
        #expect(TranscriptSettle.next(viewportMeasured: true, rowCount: 50, atBottom: true, elapsed: 1, retries: 0, keepAnchor: true) == .done)
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
