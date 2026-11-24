import Foundation
import Testing

@testable import SqueakMacCore

@Suite("PressLedger: what a press draws, and what settles it")
struct PressLedgerTests {
    private func context(
        mode: SendMode = .queue, midTurn: Bool = false, openSqueak: Bool = true, onTimeline: Bool = true,
        addon: Bool = false, clearsDraft: Bool = true
    ) -> PressLedger.Context {
        .init(mode: mode, midTurn: midTurn, isOpenSqueakChat: openSqueak, onTimeline: onTimeline, addonHostWorking: addon, clearsDraft: clearsDraft)
    }

    @Test func idleTimelineChatDrawsWorkingAndOneRowAndNothingElse() {
        var ledger = PressLedger()
        let plan = ledger.press(context())
        #expect(plan.beginsWorking && plan.timelineRow)
        #expect(!plan.localCard && !plan.queueCard)
        #expect(!plan.echoes)
        #expect(ledger.inFlight.count == 1)
    }

    @Test func midTurnPressOnATimelineChatDoesNotRestartWorkingOrDrawACard() {
        var ledger = PressLedger()
        let plan = ledger.press(context(midTurn: true))
        #expect(!plan.beginsWorking && plan.timelineRow && !plan.localCard)
    }

    @Test func olderHostMidTurnPressIsALocalCardAndTheTransportDoesNotEcho() {
        var ledger = PressLedger()
        let plan = ledger.press(context(midTurn: true, onTimeline: false))
        #expect(plan.localCard && !plan.timelineRow && !plan.echoes)
        let done = ledger.settle(plan.nonce, .accepted(via: "daemon", delivery: .queued))
        #expect(done.localCard == .settle(accepted: true, queued: true))
        #expect(done.refreshPending && done.accepted)
    }

    @Test func steerAcceptedOnALocalCardIsNotQueued() {
        var ledger = PressLedger()
        let plan = ledger.press(context(mode: .steer, midTurn: true, onTimeline: false))
        let done = ledger.settle(plan.nonce, .accepted(via: "daemon", delivery: .steered))
        #expect(done.localCard == .settle(accepted: true, queued: false))
    }

    @Test func uncertainKeepsTheCardAsSentAndTheQueueCardUnclearButDoesNotRestoreTheDraft() {
        var ledger = PressLedger()
        let plan = ledger.press(context(midTurn: true, onTimeline: false, addon: true))
        let done = ledger.settle(plan.nonce, .uncertain(reason: "timeout"))
        #expect(done.localCard == .settle(accepted: true, queued: true))
        #expect(done.queueCard == .failed(reason: "timeout", unclear: true))
        #expect(!done.restoresDraft && !done.endsWorking && done.timelineFailure == nil && !done.refreshPending)
    }

    @Test func refusedIdlePressEndsWorkingMarksTheRowNotSentAndGivesTheWordsBack() {
        var ledger = PressLedger()
        let plan = ledger.press(context())
        let done = ledger.settle(plan.nonce, .refused(reason: "no"))
        #expect(done.endsWorking && done.timelineFailure == "no" && done.restoresDraft && !done.accepted)
    }

    @Test func refusedMidTurnPressLeavesTheChatWorking() {
        var ledger = PressLedger()
        let plan = ledger.press(context(midTurn: true))
        let done = ledger.settle(plan.nonce, .notSent(reason: "offline"))
        #expect(!done.endsWorking && done.timelineFailure == "offline")
    }

    @Test func aQueueCardHoldsTheWordsSoTheDraftIsNotRestored() {
        var ledger = PressLedger()
        let plan = ledger.press(context(midTurn: true, openSqueak: false, onTimeline: false, addon: true))
        #expect(plan.queueCard && !plan.localCard)
        let done = ledger.settle(plan.nonce, .notSent(reason: "x"))
        #expect(done.queueCard == .failed(reason: "x", unclear: false) && !done.restoresDraft)
    }

    @Test func aSteerNeverDrawsAQueueCard() {
        var ledger = PressLedger()
        #expect(!ledger.press(context(mode: .steer, midTurn: true, addon: true)).queueCard)
    }

    @Test func aPressThatKeepsTheDraftNeverRestoresIt() {
        var ledger = PressLedger()
        let plan = ledger.press(context(clearsDraft: false))
        #expect(!ledger.settle(plan.nonce, .refused(reason: "no")).restoresDraft)
    }

    // Racing inputs: presses overlap and answers arrive out of order.
    @Test func racingPressesSettleEachOnceAndInAnyOrder() {
        var ledger = PressLedger()
        let first = ledger.press(context())
        let second = ledger.press(context(midTurn: true))
        let third = ledger.press(context(midTurn: true, onTimeline: false))
        #expect(ledger.inFlight.count == 3)
        let b = ledger.settle(second.nonce, .refused(reason: "b"))
        #expect(b.timelineFailure == "b" && !b.endsWorking)
        let c = ledger.settle(third.nonce, .accepted(via: "d", delivery: .queued))
        #expect(c.localCard == .settle(accepted: true, queued: true))
        // the first is still unconfirmed and untouched by the others
        #expect(ledger.inFlight.keys.contains(first.nonce) && ledger.inFlight.count == 1)
        let a = ledger.settle(first.nonce, .accepted(via: "d"))
        #expect(a.accepted && a.timelineFailure == nil)
        #expect(ledger.isEmpty)
    }

    @Test func aSecondAnswerForTheSamePressSettlesNothing() {
        var ledger = PressLedger()
        let plan = ledger.press(context(midTurn: true, onTimeline: false))
        _ = ledger.settle(plan.nonce, .accepted(via: "d", delivery: .queued))
        #expect(ledger.settle(plan.nonce, .refused(reason: "late")) == PressLedger.Settlement())
    }
}
