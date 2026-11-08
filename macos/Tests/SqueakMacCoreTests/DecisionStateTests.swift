import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct DecisionStateTests {
    @Test func pendingQuestionIsLive() {
        #expect(DecisionPhase.resolve(cardToolUseId: "t1", pendingToolUseId: "t1", answeredHereToolUseId: nil) == .live)
    }

    @Test func answeredByThisMac() {
        #expect(DecisionPhase.resolve(cardToolUseId: "t1", pendingToolUseId: nil, answeredHereToolUseId: "t1") == .answeredHere)
        #expect(DecisionPhase.resolve(cardToolUseId: "t1", pendingToolUseId: "t1", answeredHereToolUseId: "t1") == .answeredHere)
    }

    @Test func noLongerPendingAndNotAnsweredHereIsElsewhere() {
        #expect(DecisionPhase.resolve(cardToolUseId: "t1", pendingToolUseId: nil, answeredHereToolUseId: nil) == .answeredElsewhere)
        #expect(DecisionPhase.resolve(cardToolUseId: "t1", pendingToolUseId: "t2", answeredHereToolUseId: nil) == .answeredElsewhere)
        #expect(DecisionPhase.resolve(cardToolUseId: "t1", pendingToolUseId: "t2", answeredHereToolUseId: "t0") == .answeredElsewhere)
    }

    @Test func composerFold() {
        #expect(ComposerFold.isFolded(decisionPending: true, expanded: false, hasDraft: false))
        #expect(!ComposerFold.isFolded(decisionPending: true, expanded: true, hasDraft: false))
        #expect(!ComposerFold.isFolded(decisionPending: true, expanded: false, hasDraft: true))
        #expect(!ComposerFold.isFolded(decisionPending: false, expanded: false, hasDraft: false))
    }

    @Test func approvalWait() {
        #expect(ApprovalWait.isWaiting(state: .blocked, awaitingApproval: true, hasQuestionCard: false))
        #expect(!ApprovalWait.isWaiting(state: .blocked, awaitingApproval: true, hasQuestionCard: true))
        #expect(!ApprovalWait.isWaiting(state: .blocked, awaitingApproval: nil, hasQuestionCard: false))
        #expect(!ApprovalWait.isWaiting(state: .working, awaitingApproval: true, hasQuestionCard: false))
    }
}
