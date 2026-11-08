import Testing
@testable import SqueakMacCore

@Suite struct ScreenLoadTests {
    @Test func skeletonOnlyUntilTheFirstReadAnswers() {
        #expect(ScreenLoad.phase(hasContent: false, firstReadDone: false) == .loading)
        #expect(ScreenLoad.phase(hasContent: false, firstReadDone: true) == .empty)
    }

    @Test func cachedContentShowsAtOnce() {
        #expect(ScreenLoad.phase(hasContent: true, firstReadDone: false) == .content)
        #expect(ScreenLoad.phase(hasContent: true, firstReadDone: true) == .content)
    }

    @Test func queueChangeWords() {
        #expect(QueueChangeKind.steer.word == "Steering…")
        #expect(QueueChangeKind.delete.word == "Deleting…")
    }
}
