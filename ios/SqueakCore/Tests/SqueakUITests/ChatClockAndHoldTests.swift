import SqueakCore
import XCTest
@testable import SqueakUI

/// Times the Mac stamps (history, steps) against times the phone stamps (a send), with the two clocks apart; a
/// steer that the same-turn history does not supersede; the same words sent twice; and the steps held across a
/// source switch.
final class ChatClockTests: XCTestCase {
    /// The Mac's clock "now"; the phone's is `skew` seconds ahead of it (negative: behind).
    let macNow = Date(timeIntervalSince1970: 1_800_000_000)
    func mac(_ ago: TimeInterval) -> Date { macNow.addingTimeInterval(-ago) }
    func iso(_ ago: TimeInterval) -> String {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: mac(ago))
    }
    func session(_ state: String = "working", turn: String? = "t1") -> PhoneSnapshot.Session {
        PhoneSnapshot.Session(
            key: "k", conductorSessionId: "c1", label: "repo · branch", agent: "claude", state: state,
            lastActivityAt: iso(600), detail: nil, git: nil, contextPercent: nil, turnId: turn, message: nil, choices: nil)
    }
    func live(_ steps: [LiveTurn.Step], history: [LiveTurn.HistoryEntry]? = nil) -> LiveTurn {
        LiveTurn(key: "k", working: true, total: steps.count, steps: steps, history: history)
    }
    func step(_ text: String, ago: TimeInterval, kind: String = "tool") -> LiveTurn.Step { .init(kind: kind, text: text, at: iso(ago)) }
    func hist(_ role: String, _ text: String, ago: TimeInterval) -> LiveTurn.HistoryEntry { .init(role: role, text: text, at: iso(ago)) }
    /// A steer sent `ago` seconds back by the Mac's clock, stamped by a phone `skew` seconds off.
    func steer(skew: TimeInterval, ago: TimeInterval = 10, status: ChatSend.Status = .steered, text: String = "Use the timer") -> ChatSend {
        ChatSend(text: text, date: mac(ago).addingTimeInterval(skew), answersTurn: "t1", status: status, mode: .steer)
    }
    func rows(_ s: PhoneSnapshot.Session, sends: [ChatSend], live: LiveTurn?, history: [LiveTurn.HistoryEntry]? = nil, skew: TimeInterval, offset: TimeInterval? = nil) -> [ChatTimeline.Row] {
        ChatTimeline.rows(session: s, remembered: nil, sends: sends, live: live, cachedHistory: history,
                          now: macNow.addingTimeInterval(skew), offset: offset ?? skew)
    }
    func label(_ rows: [ChatTimeline.Row]) -> String? { if case .working(let l, _) = rows.last { l } else { nil } }
    func folded(_ rows: [ChatTimeline.Row]) -> [[TurnStep]] { rows.compactMap { if case .folded(_, let s) = $0 { s } else { nil } } }
    func hasSteer(_ rows: [ChatTimeline.Row], _ text: String? = nil) -> Bool {
        rows.contains { if case .steer(_, let t, _) = $0 { text == nil || t == text } else { false } }
    }

    // MARK: 4 · the two clocks

    func testAnUnmatchedSteerSplitsTheStepsAtTheSameInstantWhateverTheSkew() {
        // Steps the Mac stamped 25 s ago (before the steer) and 4 s ago (after it); the steer went in 10 s ago.
        let steps = [step("Read a.ts", ago: 25), step("Edit a.ts", ago: 4)]
        for skew: TimeInterval in [0, 20, -20, 300, -300] {
            let r = rows(session(), sends: [steer(skew: skew)], live: live(steps), skew: skew)
            XCTAssertEqual(folded(r), [[TurnStep(kind: "tool", text: "Read a.ts")]], "skew \(skew)")
            XCTAssertEqual(r.last, .working(label: "Editing a file…", steps: [TurnStep(kind: "tool", text: "Edit a.ts")]), "skew \(skew)")
        }
    }

    func testWithoutTheSkewAFastPhoneFoldsEveryStepAndReadsTheMessage() {
        // The bug this fixes, kept as a control: the phone's 20 s lead put the steer after every step.
        let steps = [step("Read a.ts", ago: 25), step("Edit a.ts", ago: 4)]
        let r = rows(session(), sends: [steer(skew: 20)], live: live(steps), skew: 20, offset: 0)
        XCTAssertEqual(label(r), "Reading your message…")
    }

    func testASteerNoStepFollowsStillSaysReadingWhateverTheSkew() {
        let steps = [step("Read a.ts", ago: 25)]
        for skew: TimeInterval in [0, 20, -20, 300, -300] {
            let r = rows(session(), sends: [steer(skew: skew)], live: live(steps), skew: skew)
            XCTAssertEqual(label(r), "Reading your message…", "skew \(skew)")
        }
    }

    func testAnAnswerAfterTheSteerEndsReadingWhateverTheSkew() {
        // The agent spoke 3 s ago, after the steer (10 s ago): never "Reading your message…".
        for skew: TimeInterval in [20, -20, 300, -300] {
            let history = [hist("user", "Start", ago: 900), hist("assistant", "Note", ago: 3)]
            let r = rows(session(), sends: [steer(skew: skew)], live: live([]), history: history, skew: skew)
            XCTAssertNotEqual(label(r), "Reading your message…", "skew \(skew)")
        }
    }

    func testSupersededJudgesTheHistoryOnTheMacsClock() {
        // A later turn. An agent message 15 s ago came BEFORE the steer (10 s ago); one 4 s ago came after it.
        for skew: TimeInterval in [0, 20, -20, 300, -300] {
            let early = [hist("user", "Start", ago: 900), hist("assistant", "Early", ago: 15)]
            let r = rows(session(turn: "t2"), sends: [steer(skew: skew)], live: live([step("Edit a.ts", ago: 1)]), history: early, skew: skew)
            XCTAssertTrue(hasSteer(r), "an earlier message does not supersede it · skew \(skew)")
            let late = [hist("user", "Start", ago: 900), hist("assistant", "Later", ago: 4)]
            let s = rows(session(turn: "t2"), sends: [steer(skew: skew)], live: live([step("Edit a.ts", ago: 1)]), history: late, skew: skew)
            XCTAssertFalse(hasSteer(s), "a later one does · skew \(skew)")
        }
    }

    func testArrivalByTimeUsesTheMacsClock() {
        let entry = hist("user", "different words", ago: 8)   // written 2 s after a send made 10 s ago
        for skew: TimeInterval in [20, -20, 300, -300] {
            let send = ChatSend(text: "typed words", date: mac(10).addingTimeInterval(skew), answersTurn: nil, status: .notConfirmed)
            XCTAssertTrue(ChatTimeline.arrivedByTime(send, in: [entry], offset: skew), "skew \(skew)")
            XCTAssertTrue(ChatTimeline.timeMatch(entry, send, offset: skew), "skew \(skew)")
        }
        let fast = ChatSend(text: "typed words", date: mac(10).addingTimeInterval(300), answersTurn: nil, status: .notConfirmed)
        XCTAssertFalse(ChatTimeline.arrivedByTime(fast, in: [entry]), "unaware of the skew it never matches")
    }

    func testArrivedByWordsUsesTheMacsClock() {
        let entry = hist("user", "Use the timer", ago: 8)
        let send = ChatSend(text: "Use the timer", date: mac(10).addingTimeInterval(300), answersTurn: nil, status: .notConfirmed)
        XCTAssertFalse(ChatTimeline.arrived(send, in: [entry]))
        XCTAssertTrue(ChatTimeline.arrived(send, in: [entry], offset: 300))
        let slow = ChatSend(text: "Use the timer", date: mac(10).addingTimeInterval(-300), answersTurn: nil, status: .notConfirmed)
        XCTAssertTrue(ChatTimeline.arrived(slow, in: [entry], offset: -300))
    }

    func testTheOutboxJudgesAnUnconfirmedSendOnTheMacsClock() {
        let entry = hist("user", "typed words", ago: 8)
        let send = ChatSend(text: "typed words", date: mac(10).addingTimeInterval(300), answersTurn: nil, status: .notConfirmed)
        XCTAssertEqual(OutboxPolicy.prune([send], history: [entry], now: macNow.addingTimeInterval(300), offset: 300).first?.status, .sent)
    }

    func testAnUnmatchedSendIsOrderedByTheMacsClock() {
        // Sent 40 s ago by the Mac's clock; the agent answered 30 s ago and 5 s ago. A fast phone must not float it
        // to the bottom, nor a slow one bury it above the first message.
        let history = [hist("user", "Start", ago: 900), hist("assistant", "First", ago: 30), hist("assistant", "Second", ago: 5)]
        for skew: TimeInterval in [20, -20, 300, -300] {
            let send = ChatSend(text: "Odd words", date: mac(40).addingTimeInterval(skew), answersTurn: "t0", status: .notConfirmed)
            let r = ChatTimeline.rows(session: session("finished", turn: "t0"), remembered: nil, sends: [send], cachedHistory: history,
                                      now: macNow.addingTimeInterval(skew), offset: skew)
            let at = r.firstIndex { if case .sent = $0 { true } else { false } }
            let first = r.firstIndex { if case .history(_, _, "First", _) = $0 { true } else { false } }
            XCTAssertNotNil(at); XCTAssertNotNil(first)
            XCTAssertTrue(at! < first!, "skew \(skew)")
        }
    }

    // MARK: 5 · a message typed at the laptop in the same turn

    func testAMessageTypedInConductorBeforeTheSteerWasDeliveredDoesNotEndIt() {
        // The phone's steer A is still waiting; B, typed in Conductor, is in the history. Same turn: A is not done.
        let a = steer(skew: 0, ago: 10, status: .sending)
        let history = [hist("user", "Start", ago: 900), hist("user", "B typed at the laptop", ago: 4)]
        let r = rows(session(turn: "t1"), sends: [a], live: live([step("Edit a.ts", ago: 1)]), history: history, skew: 0)
        XCTAssertTrue(hasSteer(r, "Use the timer"))
    }

    func testTheNextTurnEndsASteerAUserMessageFollowed() {
        let a = steer(skew: 0, ago: 10, status: .sending)
        let history = [hist("user", "Start", ago: 900), hist("user", "B typed at the laptop", ago: 4)]
        let r = rows(session(turn: "t2"), sends: [a], live: live([step("Edit a.ts", ago: 1)]), history: history, skew: 0)
        XCTAssertFalse(hasSteer(r))
        XCTAssertTrue(r.contains { if case .sent(let s) = $0 { s.text == "Use the timer" } else { false } })
    }

    func testTheAgentSpeakingInTheSameTurnDoesNotEndASteerEither() {
        let a = steer(skew: 0, ago: 10, status: .sending)
        let history = [hist("user", "Start", ago: 900), hist("assistant", "Note", ago: 4)]
        let r = rows(session(turn: "t1"), sends: [a], live: live([step("Edit a.ts", ago: 1)]), history: history, skew: 0)
        XCTAssertTrue(hasSteer(r, "Use the timer"))
    }

    func testALaterPlainSendOfThisPhoneStillEndsASteer() {
        let a = steer(skew: 0, ago: 300)
        let next = ChatSend(text: "Next question", date: mac(100), answersTurn: "t1", status: .sent)
        let r = rows(session(turn: "t1"), sends: [a, next], live: live([step("Read a.ts", ago: 1)]), skew: 0)
        XCTAssertFalse(hasSteer(r))
    }

    // MARK: 7 · the same words twice

    func testAnOlderIdenticalMessageIsNotHiddenByASteerOfTheSameWords() {
        // "?" was typed an hour ago, and again as a steer 10 s ago that the transcript shows inside the turn.
        let history = [hist("user", "?", ago: 3600), hist("assistant", "Answer", ago: 3500), hist("user", "Start", ago: 900)]
        let steps = [step("?", ago: 10, kind: "you"), step("Edit a.ts", ago: 2)]
        let r = rows(session(), sends: [], live: live(steps, history: history), skew: 0)
        XCTAssertTrue(r.contains { if case .history(_, true, "?", _) = $0 { true } else { false } }, "the old one stays")
        XCTAssertTrue(hasSteer(r, "?"), "the new one is in the turn")
    }

    func testTheSteerItselfInTheHistoryIsStillNotShownTwice() {
        let history = [hist("user", "Start", ago: 900), hist("user", "?", ago: 9)]
        let steps = [step("?", ago: 10, kind: "you"), step("Edit a.ts", ago: 2)]
        let r = rows(session(), sends: [], live: live(steps, history: history), skew: 0)
        XCTAssertFalse(r.contains { if case .history(_, true, "?", _) = $0 { true } else { false } })
        XCTAssertEqual(r.filter { if case .steer(_, "?", _) = $0 { true } else { false } }.count, 1)
    }

    func testAnOlderIdenticalMessageIsKeptNextToAPhoneSteerOfTheSameWordsOnAnySkew() {
        for skew: TimeInterval in [0, 20, -300] {
            let a = steer(skew: skew, ago: 10, status: .sending, text: "?")
            let history = [hist("user", "?", ago: 3600), hist("assistant", "Answer", ago: 3500), hist("user", "Start", ago: 900)]
            let r = rows(session(), sends: [a], live: live([step("Edit a.ts", ago: 2)], history: history), skew: skew)
            XCTAssertTrue(r.contains { if case .history(_, true, "?", _) = $0 { true } else { false } }, "skew \(skew)")
            XCTAssertTrue(hasSteer(r, "?"), "skew \(skew)")
        }
    }

    func testStepsWithoutStampsStillMatchByWords() {
        let history = [hist("user", "Start", ago: 900), hist("user", "?", ago: 9)]
        let steps = [LiveTurn.Step(kind: "you", text: "?"), LiveTurn.Step(kind: "tool", text: "Edit a.ts")]
        let r = rows(session(), sends: [], live: live(steps, history: history), skew: 0)
        XCTAssertFalse(r.contains { if case .history(_, true, "?", _) = $0 { true } else { false } })
    }

    func testSteerTextMatching() {
        let t = ChatTimeline.SteerText(text: "?", at: mac(0), window: -30...30)
        XCTAssertTrue(t.matches(.init(role: "user", text: "?", at: iso(10))))
        XCTAssertFalse(t.matches(.init(role: "user", text: "?", at: iso(3600))))
        XCTAssertFalse(t.matches(.init(role: "user", text: "other", at: iso(0))))
        XCTAssertTrue(t.matches(.init(role: "user", text: "?")), "an undated entry falls back to its words")
        XCTAssertTrue(ChatTimeline.SteerText(text: "?").matches(.init(role: "user", text: "?", at: iso(3600))), "no time known: words only")
    }

    // MARK: the skew reaches the rows through the store's input

    func testTheOffsetOfAnInputReachesTheRows() {
        let steps = [step("Read a.ts", ago: 25), step("Edit a.ts", ago: 4)]
        var input = TimelineInput(session: session(), remembered: nil, sends: [steer(skew: 20)], live: live(steps), cachedHistory: nil)
        let unaware = input.build(now: macNow.addingTimeInterval(20))
        XCTAssertEqual(label(unaware.rows), "Reading your message…")
        input.offset = 20
        let aware = input.build(now: macNow.addingTimeInterval(20))
        XCTAssertEqual(label(aware.rows), "Editing a file…")
    }
}

@MainActor
final class ChatStepHoldTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    final class Tick: @unchecked Sendable { var now: Date; init(_ d: Date) { now = d } }

    func session(key: String = "k", state: String = "working", turn: String? = "t1", snapshotSteps: [PhoneSnapshot.Step] = []) -> PhoneSnapshot.Session {
        PhoneSnapshot.Session(
            key: key, conductorSessionId: "c1", label: "repo · branch", agent: "claude", state: state,
            lastActivityAt: "2026-11-08T10:00:00.000Z", detail: nil, git: nil, contextPercent: nil, turnId: turn, message: state == "working" ? nil : "Done",
            choices: nil, activity: snapshotSteps.isEmpty ? nil : .init(total: snapshotSteps.count, steps: snapshotSteps))
    }
    func live(key: String = "k", working: Bool = true, _ steps: [LiveTurn.Step]) -> LiveTurn {
        LiveTurn(key: key, working: working, total: steps.count, steps: steps)
    }
    let edit = LiveTurn.Step(kind: "tool", text: "Edit a.ts", at: "2026-11-08T10:00:00.000Z")
    let readZ = PhoneSnapshot.Step(kind: "tool", text: "Read z.ts")
    func input(_ s: PhoneSnapshot.Session, live: LiveTurn?) -> TimelineInput {
        TimelineInput(session: s, remembered: nil, sends: [], live: live, cachedHistory: [.init(role: "user", text: "go")])
    }
    func store(_ tick: Tick) -> ChatTimelineStore { ChatTimelineStore(sleep: { _ in await Task.yield() }, clock: { tick.now }) }
    func steps(_ store: ChatTimelineStore) -> [TurnStep] {
        if case .working(_, let steps) = store.frame?.rows.last { steps } else { [] }
    }

    func testTheLastLiveStepsAreHeldForAsLongAsTheChatKeepsWorking() async {
        let tick = Tick(now)
        let store = store(tick)
        let snap = session(snapshotSteps: [readZ])
        store.submit(input(snap, live: live([edit])))
        await store.settle()
        XCTAssertEqual(steps(store), [TurnStep(kind: "tool", text: "Edit a.ts")])
        // The live document blinks off, for a minute, ten minutes: the snapshot's six never replace them.
        for later: TimeInterval in [2, 70, 700] {
            tick.now = now.addingTimeInterval(later)
            store.submit(input(snap, live: live(working: false, [])))
            await store.settle()
            XCTAssertEqual(steps(store), [TurnStep(kind: "tool", text: "Edit a.ts")], "after \(later) s")
        }
    }

    func testTheHoldEndsWhenTheChatRests() async {
        let tick = Tick(now)
        let store = store(tick)
        store.submit(input(session(), live: live([edit])))
        await store.settle()
        tick.now = now.addingTimeInterval(1)
        store.submit(input(session(state: "finished"), live: nil))
        await store.settle()
        tick.now = now.addingTimeInterval(10)
        store.submit(input(session(state: "finished"), live: nil))
        await store.settle()
        // Working again, snapshot only: nothing from the turn before is held over.
        tick.now = now.addingTimeInterval(20)
        store.submit(input(session(snapshotSteps: [readZ]), live: nil))
        await store.settle()
        XCTAssertEqual(steps(store), [TurnStep(kind: "tool", text: "Read z.ts")])
    }

    func testABriefRestBetweenWorkersKeepsTheHold() async {
        let tick = Tick(now)
        let store = store(tick)
        store.submit(input(session(), live: live([edit])))
        await store.settle()
        tick.now = now.addingTimeInterval(1)
        store.submit(input(session(state: "finished"), live: nil))
        await store.settle()
        tick.now = now.addingTimeInterval(2)
        store.submit(input(session(snapshotSteps: [readZ]), live: live(working: false, [])))
        await store.settle()
        XCTAssertEqual(steps(store), [TurnStep(kind: "tool", text: "Edit a.ts")])
    }

    func testANewTurnDoesNotInheritTheLastTurnsSteps() async {
        let tick = Tick(now)
        let store = store(tick)
        store.submit(input(session(turn: "t1"), live: live([edit])))
        await store.settle()
        tick.now = now.addingTimeInterval(1)
        store.submit(input(session(turn: "t2", snapshotSteps: [readZ]), live: live(working: false, [])))
        await store.settle()
        XCTAssertEqual(steps(store), [TurnStep(kind: "tool", text: "Read z.ts")])
    }

    func testAnotherChatInTheSameStoreStartsClean() async {
        let tick = Tick(now)
        let store = store(tick)
        store.submit(input(session(key: "a"), live: live(key: "a", [edit])))
        await store.settle()
        tick.now = now.addingTimeInterval(1)
        // Chat B is working with the same turn id and nothing live: A's steps must not show in it.
        store.submit(input(session(key: "b", snapshotSteps: [readZ]), live: nil))
        await store.settle()
        XCTAssertEqual(steps(store), [TurnStep(kind: "tool", text: "Read z.ts")])
    }

    func testRestOfAnotherChatDoesNotCarryOver() async {
        // A rested for ten minutes; B opens in the same store: its steer is held from B's own first look.
        let tick = Tick(now)
        let store = store(tick)
        store.submit(input(session(key: "a", state: "finished"), live: nil))
        await store.settle()
        tick.now = now.addingTimeInterval(600)
        let steer = ChatSend(text: "Use the timer", date: tick.now.addingTimeInterval(-5), answersTurn: "t1", status: .steered, mode: .steer)
        var b = input(session(key: "b", state: "finished", turn: "t2"), live: nil)
        b.sends = [steer]
        store.submit(b)
        await store.settle()
        XCTAssertTrue(store.frame?.rows.contains { if case .steer = $0 { true } else { false } } ?? false)
    }
}
