import Testing
@testable import SqueakMacCore

@Suite struct TranscriptWindowTests {
    private func ids(_ n: Int) -> [String] { (0..<n).map { "r\($0)" } }

    @Test func opensOnNewestWindow() {
        #expect(TranscriptWindow.visible(rowIDs: ids(300), start: nil) == 260..<300)
        #expect(TranscriptWindow.visible(rowIDs: ids(10), start: nil) == 0..<10)
        #expect(!TranscriptWindow.hasHidden(rowIDs: ids(10), start: nil))
        #expect(TranscriptWindow.hasHidden(rowIDs: ids(300), start: nil))
    }

    @Test func startSurvivesAppendsAndPrepends() {
        let r = ids(300)
        #expect(TranscriptWindow.visible(rowIDs: r + ["n1", "n2"], start: "r260") == 260..<302)
        // Two older rows loaded in front: the window still begins at the same row, now two indices later.
        #expect(TranscriptWindow.visible(rowIDs: ["o1", "o2"] + r, start: "r260") == 262..<302)
    }

    @Test func missingStartFallsBackToNewest() {
        #expect(TranscriptWindow.visible(rowIDs: ids(100), start: "gone") == 60..<100)
    }

    @Test func pagingAddsOnePageAndKeepsFirstRowAsAnchor() {
        let r = ids(300)
        let e = TranscriptWindow.expanded(rowIDs: r, start: nil)
        #expect(e?.start == "r230")
        #expect(e?.anchor == "r260")
        let e2 = TranscriptWindow.expanded(rowIDs: r, start: "r230")
        #expect(e2?.start == "r200")
        #expect(e2?.anchor == "r230")
    }

    @Test func pagingClampsAtTheTopAndEndsWhenNothingHidden() {
        let e = TranscriptWindow.expanded(rowIDs: ids(50), start: nil)
        #expect(e?.start == "r0")
        #expect(e?.anchor == "r10")
        #expect(TranscriptWindow.expanded(rowIDs: ids(50), start: "r0") == nil)
        #expect(TranscriptWindow.expanded(rowIDs: ids(5), start: nil) == nil)
    }

    @Test func anchorOnlyWhileRowExists() {
        #expect(TranscriptWindow.anchorToKeep("a", rowIDs: ["a", "b"]) == "a")
        #expect(TranscriptWindow.anchorToKeep("x", rowIDs: ["a", "b"]) == nil)
        #expect(TranscriptWindow.anchorToKeep(nil, rowIDs: ["a"]) == nil)
    }

    @Test func animationOnlyForSmallAppend() {
        #expect(TranscriptWindow.shouldAnimate(old: ["a"], new: ["a", "b"]))
        #expect(!TranscriptWindow.shouldAnimate(old: ["a"], new: ["a", "b", "c", "d"]))
        #expect(!TranscriptWindow.shouldAnimate(old: [], new: ["a", "b"]))
        #expect(!TranscriptWindow.shouldAnimate(old: ["a", "b"], new: ["x", "y", "z"]))
    }

    @Test func pinnedRules() {
        #expect(TranscriptPin.followsEnd(atBottom: true, lastIsUserMessage: false))
        #expect(TranscriptPin.followsEnd(atBottom: false, lastIsUserMessage: true))
        #expect(!TranscriptPin.followsEnd(atBottom: false, lastIsUserMessage: false))
        #expect(TranscriptPin.marksNewBelow(atBottom: false, lastIsUserMessage: false))
        #expect(!TranscriptPin.marksNewBelow(atBottom: true, lastIsUserMessage: false))
    }

    @Test func jumpButtonVisibility() {
        #expect(TranscriptPin.jumpButtonVisible(atBottom: false, rowCount: 3))
        #expect(!TranscriptPin.jumpButtonVisible(atBottom: true, rowCount: 3))
        #expect(!TranscriptPin.jumpButtonVisible(atBottom: false, rowCount: 0))
    }
}
