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

    // MARK: A new chat: 0 rows, then growth

    @Test func windowFollowsAChatThatGrowsFromEmpty() {
        #expect(TranscriptWindow.visible(rowIDs: [], start: nil) == 0..<0)
        #expect(TranscriptWindow.visible(rowIDs: ids(22), start: nil) == 0..<22)
        #expect(TranscriptWindow.visible(rowIDs: ids(90), start: nil) == 50..<90)
    }

    @Test func staleStartNeverEmptiesTheWindow() {
        // A start from another chat (or a local echo that was replaced) is not in the rows: the newest rows show.
        #expect(TranscriptWindow.visible(rowIDs: ids(22), start: "local-gone") == 0..<22)
        #expect(TranscriptWindow.visible(rowIDs: ids(80), start: "other-chat-row") == 40..<80)
    }

    @Test func reanchorDropsTheStartOnEmptyChatSwapOrMissingRow() {
        #expect(TranscriptWindow.reanchored(start: "r3", oldIDs: ids(10), newIDs: ids(12)) == "r3")
        #expect(TranscriptWindow.reanchored(start: "r3", oldIDs: [], newIDs: ids(12)) == nil)
        #expect(TranscriptWindow.reanchored(start: "r3", oldIDs: ids(10), newIDs: ids(12), sameChat: false) == nil)
        #expect(TranscriptWindow.reanchored(start: "gone", oldIDs: ids(10), newIDs: ids(12)) == nil)
        #expect(TranscriptWindow.reanchored(start: nil, oldIDs: ids(10), newIDs: ids(12)) == nil)
    }

    @Test func earlierRowNeverShowsForEmptyOrShortChats() {
        let unread = EarlierPaging()
        #expect(TranscriptWindow.earlierKind(rowCount: 0, hidden: false, paging: unread) == .none)
        #expect(TranscriptWindow.earlierKind(rowCount: 0, hidden: false, paging: EarlierPaging(loading: true)) == .none)
        // Not read yet: nothing is known about earlier rows.
        #expect(TranscriptWindow.earlierKind(rowCount: 22, hidden: false, paging: unread) == .none)
        // Read, and the whole chat shows.
        #expect(TranscriptWindow.earlierKind(rowCount: 22, hidden: false, paging: EarlierPaging(reachedStart: true, known: true)) == .start)
        // The host has more, or the window hides rows.
        #expect(TranscriptWindow.earlierKind(rowCount: 22, hidden: false, paging: EarlierPaging(known: true)) == .load)
        #expect(TranscriptWindow.earlierKind(rowCount: 90, hidden: true, paging: unread) == .load)
        #expect(TranscriptWindow.earlierKind(rowCount: 90, hidden: true, paging: EarlierPaging(loading: true)) == .loading)
        #expect(TranscriptWindow.earlierKind(rowCount: 90, hidden: true, paging: EarlierPaging(error: "x")) == .failed)
    }
}
