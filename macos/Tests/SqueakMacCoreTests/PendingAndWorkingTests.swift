import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Working from the press")
struct OptimisticWorkTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func theSidebarModelReadsWorkingAtSendAndOnlyANewerIdleClearsIt() {
        let key = SessionKey(provider: "squeak", hostSessionId: "a")
        var s = HostSession(key: key, title: "t", state: .idle)
        var other = s; other.key = SessionKey(provider: "squeak", hostSessionId: "b")
        var w = OptimisticWork()
        #expect(OptimisticWork.overlay([s, other], work: [:], now: t0).map(\.state) == [.idle, .idle])
        w.begin(at: t0, baselineSeq: 10)
        #expect(OptimisticWork.overlay([s, other], work: [key: w], now: t0).map(\.state) == [.working, .idle])
        w.observe(status: .idle) // older idle
        #expect(OptimisticWork.overlay([s], work: [key: w], now: t0).first?.state == .working)
        s.state = .blocked
        #expect(OptimisticWork.overlay([s], work: [key: w], now: t0).first?.state == .blocked)
        w.observe(message: 11, role: .user)
        w.observe(status: .idle) // newer idle ends it
        #expect(!w.isStarted)
        #expect(OptimisticWork.overlay([HostSession(key: key, title: "t", state: .idle)], work: [key: w].filter { $0.value.isStarted }, now: t0).first?.state == .idle)
    }

    @Test func anOptionTapOnABlockedChatReadsWorkingAtOnce() {
        var w = OptimisticWork()
        w.begin(at: t0, baselineSeq: 10, answeringBlocked: true)
        #expect(w.resolve(host: .blocked, now: t0) == .working)
        w.observe(status: .blocked) // the stale blocked again: still ours
        #expect(w.resolve(host: .blocked, now: t0) == .working)
        w.observe(message: 11, role: .user)
        w.observe(status: .blocked) // a new request after our answer is real
        #expect(w.resolve(host: .blocked, now: t0) == .blocked)
        var plain = OptimisticWork()
        plain.begin(at: t0)
        #expect(plain.resolve(host: .blocked, now: t0) == .blocked)
    }

    @Test func theChatReadsWorkingTheInstantSendIsPressed() {
        var w = OptimisticWork()
        #expect(w.resolve(host: .idle, now: t0) == .idle)
        w.begin(at: t0, baselineSeq: 10)
        #expect(w.resolve(host: .idle, now: t0) == .working)
        #expect(w.resolve(host: .finished, now: t0) == .working)
        #expect(w.isActive(host: .idle, now: t0))
        // the host agreeing changes nothing the person sees
        #expect(w.resolve(host: .working, now: t0) == .working)
        #expect(!w.isActive(host: .working, now: t0))
    }

    @Test func anOlderIdleNeverOverridesASendNewerThanIt() {
        var w = OptimisticWork()
        w.begin(at: t0, baselineSeq: 10)
        // the previous turn's idle arriving after the send: our own message (seq 11) has not been seen
        w.observe(status: .idle)
        w.observe(status: .error)
        #expect(w.resolve(host: .idle, now: t0.addingTimeInterval(1)) == .working)
        // the host shows our message, working, and only then the turn's end ends it
        w.observe(message: 9, role: .user) // an older row replayed: not ours
        w.observe(status: .idle)
        #expect(w.isStarted)
        w.observe(message: 11, role: .user)
        w.observe(status: .working)
        #expect(w.resolve(host: .idle, now: t0.addingTimeInterval(2)) == .working)
        w.observe(status: .idle)
        #expect(!w.isStarted)
        #expect(w.resolve(host: .idle, now: t0.addingTimeInterval(3)) == .idle)
    }

    @Test func aTurnThatErrorsAfterOurMessageEndsIt() {
        var w = OptimisticWork()
        w.begin(at: t0, baselineSeq: 4)
        w.observe(message: 5, role: .user)
        #expect(w.resolve(host: .error, now: t0) == .error)
        w.observe(status: .error)
        #expect(!w.isStarted)
    }

    @Test func aFailedSendRevertsAtOnce() {
        var w = OptimisticWork()
        w.begin(at: t0)
        w.failed()
        #expect(w.resolve(host: .idle, now: t0) == .idle)
    }

    @Test func aChatWaitingOnThePersonIsNeverOverridden() {
        var w = OptimisticWork()
        w.begin(at: t0)
        #expect(w.resolve(host: .blocked, now: t0) == .blocked)
    }

    @Test func aSendTheHostNeverAnsweredStopsCounting() {
        var w = OptimisticWork()
        w.begin(at: t0)
        #expect(w.resolve(host: .idle, now: t0.addingTimeInterval(OptimisticWork.cap - 1)) == .working)
        #expect(w.resolve(host: .idle, now: t0.addingTimeInterval(OptimisticWork.cap + 1)) == .idle)
    }

    @Test func aChatWithNoSeqNeedsWorkingBeforeAnIdleCountsAndAReplyEndsAShortTurn() {
        var w = OptimisticWork()
        w.begin(at: t0)
        w.observe(status: .finished) // the state from before the send
        #expect(w.isStarted)
        w.observe(status: .working)
        w.observe(status: .finished)
        #expect(!w.isStarted)
        // a short turn the poll never saw working: the reply lands and the host is not working
        var short = OptimisticWork()
        short.begin(at: t0)
        short.observeReply(host: .working)
        #expect(short.isStarted)
        short.observeReply(host: .finished)
        #expect(!short.isStarted)
    }

    @Test func aSecondSendKeepsTheFirstOnesStart() {
        var w = OptimisticWork()
        w.begin(at: t0, baselineSeq: 1)
        w.begin(at: t0.addingTimeInterval(30), baselineSeq: 9)
        #expect(w.sentAt == t0)
        #expect(w.baselineSeq == 1)
    }
}

@Suite("Queue stack")
struct NativePendingStackTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    func item(_ id: String, _ text: String, _ state: NativePendingItem.State = .queued, at: TimeInterval, held: Bool = false, seq: Int? = nil) -> NativePendingItem {
        NativePendingItem(id: id, text: text, state: state, createdAt: t0.addingTimeInterval(at), held: held, seq: seq)
    }

    @Test func newestIsLastWhateverOrderTheHostListedThem() {
        var s = NativePendingStack()
        s.apply(.snapshot([item("b", "second", at: 2), item("a", "first", at: 1)]))
        s.apply(.add(item("c", "third", at: 3)))
        #expect(s.cards.map(\.text) == ["first", "second", "third"])
        // Mac's own just-sent message goes last until the host lists it
        s.beginLocal(id: "l1", text: "typing fast", steer: false, at: t0.addingTimeInterval(4))
        #expect(s.cards.map(\.text) == ["first", "second", "third", "typing fast"])
        #expect(s.cards.last?.kind == .sending)
    }

    @Test func updateHoldsAndRemoveDrops() {
        var s = NativePendingStack()
        s.apply(.add(item("a", "first", at: 1)))
        s.apply(.update(item("a", "first!", at: 1, held: true)))
        #expect(s.cards == [.init(id: "a", text: "first!", kind: .queued, held: true, isLocal: false)])
        s.apply(.remove(id: "a", consumed: false, seq: nil))
        #expect(s.cards.isEmpty)
    }

    @Test func theHostsOwnItemReplacesTheMacsCard() {
        var s = NativePendingStack()
        s.beginLocal(id: "l1", text: "later", steer: false, at: t0)
        s.settleLocal(id: "l1", accepted: true, queued: true)
        #expect(s.cards.count == 1)
        s.apply(.add(item("q1", "later", at: 1)))
        #expect(s.cards.map(\.id) == ["q1"])
        #expect(s.locals.isEmpty)
    }

    @Test func aFailedOrTakenInAtOnceSendLeavesNoCard() {
        var s = NativePendingStack()
        s.beginLocal(id: "l1", text: "x", steer: false, at: t0)
        s.settleLocal(id: "l1", accepted: false, queued: false)
        #expect(s.cards.isEmpty)
        s.beginLocal(id: "l2", text: "steer", steer: true, at: t0)
        #expect(s.cards.first?.kind == .steering)
        s.settleLocal(id: "l2", accepted: true, queued: false) // Codex: taken in, no card of its own
        #expect(s.cards.isEmpty)
        // an accepted queue send the host never lists goes after the grace
        s.beginLocal(id: "l3", text: "y", steer: false, at: t0)
        s.settleLocal(id: "l3", accepted: true, queued: true)
        s.prune(now: t0.addingTimeInterval(NativePendingStack.settleGrace - 1))
        #expect(s.cards.count == 1)
        s.prune(now: t0.addingTimeInterval(NativePendingStack.settleGrace + 1))
        #expect(s.cards.isEmpty)
    }

    @Test func aSteerStaysOutOfTheTranscriptUntilConsumedThenShowsAtFullWeight() {
        var s = NativePendingStack()
        let rows = [
            ChatMessage(id: "native-1", role: .user, text: "go", state: .confirmed),
            ChatMessage(id: "native-2", role: .assistant, text: "working"),
            ChatMessage(id: "native-3", role: .user, text: "also this"),
        ]
        s.apply(.add(item("p1", "also this", .steering, at: 1, seq: 3)))
        #expect(s.cards.first?.kind == .steering)
        #expect(s.visible(rows).map(\.id) == ["native-1", "native-2"])
        // consumed: the card goes, the row is a plain transcript row where it was absorbed
        s.apply(.remove(id: "p1", consumed: true, seq: 3))
        #expect(s.cards.isEmpty)
        #expect(s.consumedSeqs == [3])
        #expect(s.visible(rows).map(\.id) == ["native-1", "native-2", "native-3"])
        #expect(SentBubble.look(rows[2]) == .taken)
    }

    @Test func aQueuedMessageIsNeverHiddenFromTheTranscriptByItsSeq() {
        var s = NativePendingStack()
        s.apply(.add(item("q", "later", .queued, at: 1, seq: 3)))
        #expect(s.visible([ChatMessage(id: "native-3", role: .user, text: "x")]).count == 1)
    }

    @Test func returnQueuesAndCommandReturnSteersWhileWorking() {
        #expect(ComposerKeys.action(.plain, working: true) == .queue)
        #expect(ComposerKeys.mode(.queue) == .queue)
        #expect(ComposerKeys.action(.command, working: true) == .steer)
        #expect(ComposerKeys.mode(.steer) == .steer)
        // idle: either sends
        #expect(ComposerKeys.action(.plain, working: false) == .send)
        #expect(ComposerKeys.action(.command, working: false) == .send)
    }

    @Test func pendingFramesDecodeFromTheStream() throws {
        func event(_ json: String) -> NativeEvent? { NativeEvent.from(SSEFrame(event: "pending", data: json, id: nil)) }
        let add = event(#"{"op":"add","id":"p1","item":{"id":"p1","text":"hi","state":"steering","createdAt":"2026-11-12T10:00:00.000Z","seq":7}}"#)
        guard case .pending(.add(let item))? = add else { Issue.record("not an add"); return }
        #expect(item.state == .steering && item.seq == 7 && item.text == "hi" && !item.held)
        #expect(event(#"{"op":"remove","id":"p1","consumed":true,"seq":7}"#) == .pending(.remove(id: "p1", consumed: true, seq: 7)))
        #expect(event(#"{"op":"remove","id":"p2"}"#) == .pending(.remove(id: "p2", consumed: false, seq: nil)))
        guard case .pending(.snapshot(let items))? = event(#"{"op":"snapshot","items":[{"id":"a","text":"x","state":"queued","held":true}]}"#) else {
            Issue.record("not a snapshot"); return
        }
        #expect(items.first?.held == true)
        #expect(event(#"{"op":"nope"}"#) == nil)
    }
}

@Suite("Overlay cache")
struct OverlayCacheTests {
    @Test func recomputesOnlyAfterInvalidate() {
        let key = SessionKey(provider: "squeak", hostSessionId: "a")
        let s = [HostSession(key: key, title: "t", state: .idle)]
        var w = OptimisticWork(); w.begin(at: Date(), baselineSeq: 1)
        var c = OverlayCache()
        #expect(c.value(s, work: [key: w], now: Date()).first?.state == .working)
        _ = c.value(s, work: [key: w], now: Date()); _ = c.value(s, work: [key: w], now: Date())
        #expect(c.recomputes == 1)
        c.invalidate()
        #expect(c.value(s, work: [:], now: Date()).first?.state == .idle)
        #expect(c.recomputes == 2)
    }
}
