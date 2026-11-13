import Testing
@testable import SqueakMacCore

struct DraftPolicyTests {
    @Test func choosingAnOptionLeavesTheDraft() {
        #expect(!DraftPolicy.clearsDraft(answering: true, requested: true))
    }
    @Test func anOrdinarySendClearsIt() {
        #expect(DraftPolicy.clearsDraft(answering: false, requested: true))
    }
    @Test func aSendThatAsksToKeepItKeepsIt() {
        #expect(!DraftPolicy.clearsDraft(answering: false, requested: false))
    }
}
