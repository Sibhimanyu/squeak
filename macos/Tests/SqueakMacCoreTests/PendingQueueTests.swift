import Foundation
import Testing
@testable import SqueakMacCore

struct PendingQueueTests {
    let t0 = Date(timeIntervalSince1970: 1_000)

    func item(_ text: String, baseline: Set<String> = [], at: Date? = nil, accepted: Bool = false) -> PendingQueueItem {
        PendingQueueItem(id: "p-\(text)", text: text, sentAt: at ?? t0, baseline: baseline, accepted: accepted)
    }

    @Test func aPolledMessageWithTheSameTextReplacesThePendingOne() {
        let r = PendingQueue.reconcile(pending: [item("fix it")], polled: [QueuedMessage(id: "m1", text: " fix  it ")], now: t0)
        #expect(r.pending.isEmpty)
        #expect(r.matched == ["m1"])
    }

    @Test func aMessageAlreadyQueuedBeforeTheSendIsNotTheMatch() {
        let polled = [QueuedMessage(id: "old", text: "go"), QueuedMessage(id: "new", text: "go")]
        let r = PendingQueue.reconcile(pending: [item("go", baseline: ["old"])], polled: polled, now: t0)
        #expect(r.matched == ["new"])
    }

    @Test func twoIdenticalSendsClaimTwoMessagesOnce() {
        let a = item("go", at: t0), b = PendingQueueItem(id: "p2", text: "go", sentAt: t0 + 1, baseline: [])
        let r = PendingQueue.reconcile(pending: [b, a], polled: [QueuedMessage(id: "m1", text: "go")], now: t0 + 2)
        #expect(r.matched == ["m1"])
        #expect(r.pending.map(\.id) == ["p2"])
    }

    @Test func noMatchKeepsItPendingUntilAnAcceptedOneExpires() {
        let polled = [QueuedMessage(id: "x", text: "other")]
        #expect(PendingQueue.reconcile(pending: [item("go")], polled: polled, now: t0 + 100).pending.count == 1)
        #expect(PendingQueue.reconcile(pending: [item("go", accepted: true)], polled: polled, now: t0 + 5).pending.count == 1)
        #expect(PendingQueue.reconcile(pending: [item("go", accepted: true)], polled: polled, now: t0 + 21).pending.isEmpty)
    }

    @Test func failedItemsStayForTheirRetryOrEdit() {
        var f = item("go"); f.state = .failed(reason: "no")
        let r = PendingQueue.reconcile(pending: [f], polled: [QueuedMessage(id: "m", text: "go")], now: t0 + 500)
        #expect(r.pending == [f])
        #expect(r.matched.isEmpty)
    }

    @Test func rowsListPolledThenPending() {
        let rows = PendingQueue.rows(polled: [QueuedMessage(id: "m", text: "a")], pending: [item("b")])
        #expect(rows.map(\.id) == ["m", "pending-p-b"])
    }

    @Test func pollsEverySecondForTenSecondsAfterASend() {
        #expect(PendingQueue.pollInterval(sinceSend: nil) == 2.5)
        #expect(PendingQueue.pollInterval(sinceSend: 0) == 1)
        #expect(PendingQueue.pollInterval(sinceSend: 9.9) == 1)
        #expect(PendingQueue.pollInterval(sinceSend: 10) == 2.5)
    }

    @Test func theDefaultDecidesThePrimaryAndTheOther() {
        #expect(SendDefault(.queue).primary == .queue)
        #expect(SendDefault(.queue).other == .steer)
        #expect(SendDefault(.steer).primary == .steer)
        #expect(SendDefault(.steer).other == .queue)
        #expect(SendDefault(.steer).help(agent: "Claude").hasPrefix("Steer"))
        #expect(SendDefault(.queue).help(agent: "Claude").contains("⇧⌘↩"))
    }
}
