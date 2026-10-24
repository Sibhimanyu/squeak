import SqueakCore
import XCTest
@testable import SqueakUI

final class ChatTimelineTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    func iso(_ ago: TimeInterval) -> String {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: now.addingTimeInterval(-ago))
    }

    func session(_ state: String, turn: String? = "t1", message: String? = nil, detail: String? = nil,
                 steps: [PhoneSnapshot.Step] = [], ago: TimeInterval = 600, conductor: Bool = true) -> PhoneSnapshot.Session {
        PhoneSnapshot.Session(
            key: "k", conductorSessionId: conductor ? "c1" : nil, label: "repo · branch", agent: "claude", state: state,
            lastActivityAt: iso(ago), detail: detail, git: nil, contextPercent: nil, turnId: turn, message: message, choices: nil,
            activity: steps.isEmpty ? nil : .init(total: steps.count, steps: steps))
    }
    func send(_ status: ChatSend.Status = .sending, turn: String? = "t1", ago: TimeInterval = 5) -> ChatSend {
        ChatSend(text: "go", date: now.addingTimeInterval(-ago), answersTurn: turn, status: status)
    }
    /// The same send as the chat shows it once the agent has it.
    func read(_ s: ChatSend) -> ChatSend { var c = s; c.status = .read(agent: "Claude"); return c }
    let previous = RememberedMessage(text: "Earlier answer", atISO: "2026-01-01T10:00:00.000Z", turnId: "t1")
    func tool(_ text: String) -> PhoneSnapshot.Step { .init(kind: "tool", text: text) }

    func testNeverEmptyWhileWorking() {
        let rows = ChatTimeline.rows(session: session("working", turn: "t2"), remembered: nil, sends: [], now: now)
        XCTAssertEqual(rows, [.working(label: "Starting…")])
    }

    func testGenuinelyEmptyChatSaysSoPerSection87() {
        let rows = ChatTimeline.rows(session: session("idle", turn: nil), remembered: nil, sends: [], now: now)
        XCTAssertEqual(rows, [.empty(ChatTimeline.emptyText(canReply: true))])
        let blocked = ChatTimeline.rows(session: session("idle", turn: nil, conductor: false), remembered: nil, sends: [], now: now)
        XCTAssertEqual(blocked, [.empty("No messages from this chat yet.")])
    }

    func testSendShowsBubbleAndStartingBeforeTheSnapshotCatchesUp() {
        // The Mac has not reported `working` yet: the session still looks finished with the old turn.
        let s = send()
        let rows = ChatTimeline.rows(session: session("finished", message: "Earlier answer"), remembered: previous, sends: [s], now: now)
        XCTAssertEqual(rows, [.agent(text: "Earlier answer", atISO: previous.atISO, muted: true), .sent(s), .working(label: "Starting…")])
    }

    func testLiveStepAndWorkingFromConductorItself() {
        let steps = [tool("Read src/a.ts"), tool("Run npm test -- a")]
        let rows = ChatTimeline.rows(session: session("working", turn: "t2", steps: steps), remembered: previous, sends: [], now: now)
        XCTAssertEqual(rows, [.agent(text: "Earlier answer", atISO: previous.atISO, muted: true),
                              .working(label: "Running tests…", steps: steps.map { TurnStep(kind: $0.kind, text: $0.text) })])
        XCTAssertEqual(ChatTimeline.workingLabel([tool("Read src/a.ts")]), "Reading code…")
        XCTAssertEqual(ChatTimeline.workingLabel([.init(kind: "thinking", text: "hm")]), "Thinking…")
        // A step Squeak does not phrase reads as its own label, not a bare "Working…".
        XCTAssertEqual(ChatTimeline.workingLabel([tool("Frobnicate")]), "Frobnicate…")
        XCTAssertEqual(ChatTimeline.workingLabel([]), "Starting…")
    }

    func testReplyReplacesTheWorkingRowAndTheBubbleStaysOnce() {
        let s = send(.sent)
        let rows = ChatTimeline.rows(session: session("finished", turn: "t2", message: "New answer", ago: 1), remembered: previous, sends: [s], now: now)
        // The send answered t1, so it sits before t2's reply; no working row, no duplicate, no empty.
        XCTAssertEqual(rows, [.sent(read(s)), .agent(text: "New answer", atISO: iso(1), muted: false)])
    }

    func testStillWorkingKeepsBubbleAfterThePreviousMessage() {
        let s = send(.sent)
        let rows = ChatTimeline.rows(session: session("working", turn: "t2"), remembered: previous, sends: [s], now: now)
        // Sent to a resting chat that is working now: the agent took it.
        XCTAssertEqual(rows, [.agent(text: "Earlier answer", atISO: previous.atISO, muted: true), .sent(read(s)), .working(label: "Starting…")])
    }

    func testRefusedSendShowsItsReasonAndNoWorkingRow() {
        let s = send(.refused("Waiting inside Conductor."))
        let rows = ChatTimeline.rows(session: session("finished", message: "Earlier answer"), remembered: previous, sends: [s], now: now)
        XCTAssertEqual(rows, [.agent(text: "Earlier answer", atISO: iso(600), muted: false), .sent(s)])
    }

    func testAnUnansweredSendDefersToTheMacAfterNinetySeconds() {
        // Still starting a minute in: Conductor may be picking it up from its queue.
        let early = ChatTimeline.rows(session: session("finished", message: "Earlier answer"), remembered: previous, sends: [send(.sent, ago: 60)], now: now)
        XCTAssertTrue(early.contains { if case .working = $0 { true } else { false } })
        let s = send(.sent, ago: 100)
        let rows = ChatTimeline.rows(session: session("finished", message: "Earlier answer"), remembered: previous, sends: [s], now: now)
        XCTAssertFalse(rows.contains { if case .working = $0 { true } else { false } })
    }

    func testTheListAndTheChatAgreeOnStarting() {
        let finished = session("finished", message: "Earlier answer")
        XCTAssertTrue(ChatTimeline.isStarting(session: finished, sends: [send()], now: now))
        XCTAssertFalse(ChatTimeline.isStarting(session: finished, sends: [], now: now))
        XCTAssertFalse(ChatTimeline.isStarting(session: finished, sends: [send(.sent, ago: 100)], now: now))
        // Working is the Mac's own word; "starting" is only for the gap before it.
        XCTAssertFalse(ChatTimeline.isStarting(session: session("working"), sends: [send()], now: now))
    }

    func testNeedsYouIsNeverWorking() {
        let rows = ChatTimeline.rows(session: session("awaiting_input", message: "Which one?"), remembered: previous, sends: [send(.sent)], now: now)
        XCTAssertFalse(rows.contains { if case .working = $0 { true } else { false } })
    }

    func testOneShortDeliveryLinePerSend() {
        XCTAssertEqual(ChatSend.Status.sending.line, "Sending…")
        XCTAssertEqual(ChatSend.Status.sent.line, "Sent")
        XCTAssertEqual(ChatSend.Status.notConfirmed.line, "Couldn't confirm it arrived. Check the chat before sending again.")
        XCTAssertEqual(ChatSend.Status.refused("Waiting inside Conductor.").line, "Not sent. Nothing started. Waiting inside Conductor.")
        // The Mac's own lower-case reason reads as a sentence.
        XCTAssertEqual(ChatSend.Status.refused("your Mac didn't pick it up").line, "Not sent. Nothing started. Your Mac didn't pick it up.")
    }

    func testTwoSendsWhileWorkingKeepBothBubblesInOrderThenOneWorkingRow() {
        let a = send(.sent, ago: 120), b = send(.sending, ago: 5)
        let rows = ChatTimeline.rows(session: session("working", turn: "t2"), remembered: previous, sends: [a, b], now: now)
        XCTAssertEqual(rows, [.agent(text: "Earlier answer", atISO: previous.atISO, muted: true), .sent(read(a)), .sent(b), .working(label: "Starting…")])
    }

    func result(_ json: String) throws -> CommandResult { try JSONDecoder().decode(CommandResult.self, from: Data(json.utf8)) }

    func testOnlyTheMacsSentReadsAsDelivered() throws {
        XCTAssertEqual(ChatSend.Status.verdict(try result(#"{"status":"sent","via":"conductor"}"#), agent: "Claude"), .sent)
        XCTAssertEqual(ChatSend.Status.verdict(try result(#"{"status":"sent","delivery":"queued"}"#), agent: "Claude"),
                       .queued(agent: "Claude", steerUnavailable: false))
        XCTAssertEqual(ChatSend.Status.verdict(try result(#"{"status":"refused","reason":"That chat has moved on."}"#), agent: "Claude"),
                       .refused("That chat has moved on."))
        XCTAssertEqual(ChatSend.Status.verdict(try result(#"{"status":"refused"}"#), agent: "Claude"), .refused("your Mac refused that reply."))
        // The Mac could not prove it arrived: neither sent nor refused.
        XCTAssertEqual(ChatSend.Status.verdict(try result(#"{"status":"unconfirmed","reason":"x"}"#), agent: "Claude"), .notConfirmed)
        // A status this phone does not know is not a delivery.
        XCTAssertFalse(ChatSend.Status.verdict(try result(#"{"status":"whatever"}"#), agent: "Claude") == .sent)
    }

    func testSilenceNeverReadsAsSent() {
        XCTAssertEqual(ChatSend.Status.silence(withdrawn: false), .notConfirmed)
        guard case .refused(let why) = ChatSend.Status.silence(withdrawn: true) else { return XCTFail("should be not sent") }
        XCTAssertTrue(ChatSend.Status.refused(why).line.hasPrefix("Not sent. Nothing started."))
    }

    func testNotConfirmedIsNeverShownAsStarting() {
        // Nothing proves it arrived, so no "Starting…" row: the bubble says so and offers Send again.
        let s = send(.notConfirmed)
        let rows = ChatTimeline.rows(session: session("finished", message: "Earlier answer"), remembered: previous, sends: [s], now: now)
        XCTAssertFalse(rows.contains { if case .working = $0 { true } else { false } })
        XCTAssertTrue(rows.contains(.sent(s)))
        XCTAssertTrue(s.status.failed)
        XCTAssertTrue(ChatSend.Status.refused("x").failed)
        XCTAssertFalse(ChatSend.Status.sent.failed)
        XCTAssertFalse(ChatSend.Status.sending.failed)
    }

    func testNotConfirmedBehindATurnStaysABubbleNotAQueueCard() {
        var s = ChatSend(text: "go", date: now.addingTimeInterval(-5), answersTurn: "t1", status: .notConfirmed, queuedBehindTurn: true)
        s.seenInQueue = false
        let working = session("working", turn: "t1")
        XCTAssertTrue(ChatQueue.cards(session: working, live: nil, sends: [s], now: now).isEmpty)
        // Conductor's own queue listing it proves it arrived: it is a queue card again.
        let live = LiveTurn(key: "k", working: true, total: 0, steps: [],
                            queue: [.init(id: s.messageId, text: "go", mode: "queue", position: 0)])
        XCTAssertEqual(ChatQueue.cards(session: working, live: live, sends: [s], now: now).map(\.id), [s.messageId])
    }

    func testNotConfirmedBecomesSentWhenTheChatHistoryShowsIt() {
        let s = send(.notConfirmed, ago: 120)
        let history = [LiveTurn.HistoryEntry(role: "user", text: "go", at: iso(100))]
        let rows = ChatTimeline.rows(session: session("working", turn: "t2"), remembered: previous, sends: [s], cachedHistory: history, now: now)
        var proven = s; proven.status = .sent
        XCTAssertFalse(rows.contains(.sent(s)))
        XCTAssertTrue(rows.contains { if case .sent(let shown) = $0 { shown.id == s.id && !shown.status.failed } else { false } })
        _ = proven
        // The same words from before it was sent prove nothing.
        let older = [LiveTurn.HistoryEntry(role: "user", text: "go", at: iso(3000))]
        XCTAssertFalse(ChatTimeline.arrived(s, in: older))
        XCTAssertTrue(ChatTimeline.arrived(s, in: history))
    }

    func testASendSentAgainKeepsItsFirstTimeForProof() {
        var s = send(.refused("x"), ago: 300)
        s.date = now // sent again just now
        let history = [LiveTurn.HistoryEntry(role: "user", text: "go", at: iso(290))]
        XCTAssertTrue(ChatTimeline.arrived(s, in: history), "the first try may be the one that arrived")
    }

    func testQueuedLineHoldsWhileTheAgentWorksThenReadsSent() {
        let queued = send(.queued(agent: "Claude", steerUnavailable: false), turn: "t1")
        let working = ChatTimeline.rows(session: session("working", turn: "t2"), remembered: previous, sends: [queued], now: now)
        XCTAssertTrue(working.contains(.sent(queued)))
        let after = ChatTimeline.rows(session: session("finished", turn: "t2", message: "Done"), remembered: previous, sends: [queued], now: now)
        guard case .sent(let shown)? = after.first(where: { if case .sent = $0 { true } else { false } }) else { return XCTFail("no bubble") }
        XCTAssertEqual(shown.status, .read(agent: "Claude"))
    }

    func testDeliveryLines() {
        XCTAssertEqual(ChatSend.Status.queued(agent: "Claude", steerUnavailable: false).line, "Queued · Claude reads it after this turn")
        XCTAssertEqual(ChatSend.Status.steered.line, "Steered into the current turn")
        XCTAssertEqual(ChatSend.Status.sent.line, "Sent")
        XCTAssertEqual(ChatSend.Status.refused("busy").line, "Not sent. Nothing started. Busy.")
        XCTAssertTrue(ChatSend.Status.queued(agent: "Claude", steerUnavailable: true).line.contains("steering isn't available"))
    }

    func testDeliveredStatusFollowsTheMacsWord() throws {
        func result(_ json: String) throws -> CommandResult { try JSONDecoder().decode(CommandResult.self, from: Data(json.utf8)) }
        XCTAssertEqual(ChatSend.Status.delivered(try result(#"{"status":"sent","delivery":"queued"}"#), agent: "Claude"),
                       .queued(agent: "Claude", steerUnavailable: false))
        XCTAssertEqual(ChatSend.Status.delivered(try result(#"{"status":"sent","delivery":"queued","note":"x"}"#), agent: "Claude"),
                       .queued(agent: "Claude", steerUnavailable: true))
        XCTAssertEqual(ChatSend.Status.delivered(try result(#"{"status":"sent","delivery":"steered"}"#), agent: "Claude"), .steered)
        XCTAssertEqual(ChatSend.Status.delivered(try result(#"{"status":"sent"}"#), agent: "Claude"), .sent)
    }
    /* ---------- queue and steer ---------- */

    func queuedSend(_ status: ChatSend.Status = .queued(agent: "Claude", steerUnavailable: false), id: String = "m1", ago: TimeInterval = 5, seen: Bool = false) -> ChatSend {
        var s = ChatSend(text: "Then add tests", date: now.addingTimeInterval(-ago), answersTurn: "t1", status: status,
                         messageId: id, mode: .queue, queuedBehindTurn: true)
        s.seenInQueue = seen
        return s
    }
    func liveTurn(working: Bool = true, steps: [LiveTurn.Step] = [], queue: [LiveTurn.QueuedMessage]? = nil) -> LiveTurn {
        LiveTurn(key: "k", working: working, total: steps.count, steps: steps, queue: queue)
    }

    func testAQueuedMessageIsACardNotAChatRow() {
        let q = queuedSend()
        let working = session("working", turn: "t1")
        let live = liveTurn(queue: [.init(id: "m1", text: "Then add tests")])
        let rows = ChatTimeline.rows(session: working, remembered: previous, sends: [q], live: live, now: now)
        XCTAssertFalse(rows.contains { if case .sent = $0 { true } else { false } })
        let cards = ChatQueue.cards(session: working, live: live, sends: [q], now: now)
        XCTAssertEqual(cards, [.init(id: "m1", text: "Then add tests", pending: false, actionable: true)])
    }

    func testQueueCardsIncludeConductorsOwnAndPendingOnes() {
        let q = queuedSend(.sending, id: "m2")
        let live = liveTurn(queue: [.init(id: "mac", text: "Typed on the Mac")])
        let cards = ChatQueue.cards(session: session("working", turn: "t1"), live: live, sends: [q], now: now)
        XCTAssertEqual(cards.map(\.id), ["mac", "m2"])
        XCTAssertEqual(cards.last?.pending, true)
        XCTAssertEqual(cards.last?.actionable, false)
        // Hidden on a tap until the Mac's queue catches up.
        XCTAssertEqual(ChatQueue.cards(session: session("working", turn: "t1"), live: live, sends: [q], hidden: ["mac"], now: now).map(\.id), ["m2"])
    }

    func testLeavingConductorsQueueMovesItIntoTheChat() {
        let q = queuedSend(seen: true)
        let live = liveTurn(queue: [])
        let rows = ChatTimeline.rows(session: session("working", turn: "t2"), remembered: previous, sends: [q], live: live, now: now)
        XCTAssertTrue(rows.contains { if case .sent(let s) = $0 { s.id == q.id } else { false } })
        XCTAssertTrue(ChatQueue.cards(session: session("working", turn: "t2"), live: live, sends: [q], now: now).isEmpty)
    }

    func testNotYetListedStaysACardForTheGraceThenTrustsTheMac() {
        let live = liveTurn(queue: [])
        XCTAssertTrue(ChatQueue.isQueued(queuedSend(ago: 5), session: session("working"), live: live, now: now))
        XCTAssertFalse(ChatQueue.isQueued(queuedSend(ago: 60), session: session("working"), live: live, now: now))
    }

    func testWithoutTheMacsQueueItWaitsForTheTurnToEnd() {
        let q = queuedSend()
        XCTAssertTrue(ChatQueue.isQueued(q, session: session("working", turn: "t1"), live: nil, now: now))
        XCTAssertFalse(ChatQueue.isQueued(q, session: session("finished", turn: "t2", message: "Done"), live: nil, now: now))
        let card = ChatQueue.cards(session: session("working", turn: "t1"), live: nil, sends: [q], now: now).first
        XCTAssertEqual(card?.actionable, false)
    }

    func testASteerLandsInsideTheTurnAndFoldsWhatCameBefore() {
        let steer = ChatSend(text: "Keep the fallback", date: now.addingTimeInterval(-30), answersTurn: "t1", status: .steered, mode: .steer)
        let live = liveTurn(steps: [.init(kind: "tool", text: "Read a.ts"), .init(kind: "you", text: "Keep the fallback"),
                                    .init(kind: "tool", text: "Edit a.ts")])
        let rows = ChatTimeline.rows(session: session("working", turn: "t1"), remembered: previous, sends: [steer], live: live, now: now)
        XCTAssertEqual(rows, [
            .agent(text: "Earlier answer", atISO: previous.atISO, muted: true),
            .folded(id: "part-0", steps: [TurnStep(kind: "tool", text: "Read a.ts")]),
            .steer(id: steer.id.uuidString, text: "Keep the fallback", line: ChatSend.Status.read(agent: "Claude").steerLine(at: steer.date)),
            .working(label: "Editing a file…", steps: [TurnStep(kind: "tool", text: "Edit a.ts")]),
        ])
    }

    func testASteerTheMacHasNotReportedYetGoesLastAndTheAgentIsReadingIt() {
        let steer = ChatSend(text: "Stop and use the timer", date: now.addingTimeInterval(-2), answersTurn: "t1", status: .sending, mode: .steer)
        let live = liveTurn(steps: [.init(kind: "tool", text: "Read a.ts")])
        let rows = ChatTimeline.rows(session: session("working", turn: "t1"), remembered: nil, sends: [steer], live: live, now: now)
        XCTAssertEqual(rows, [
            .folded(id: "part-0", steps: [TurnStep(kind: "tool", text: "Read a.ts")]),
            .steer(id: steer.id.uuidString, text: "Stop and use the timer", line: "Sending…"),
            .working(label: "Reading your message…", steps: []),
        ])
    }

    func testASteerTypedOnTheMacStillShowsWhereItLanded() {
        let live = liveTurn(steps: [.init(kind: "you", text: "From the Mac"), .init(kind: "tool", text: "Edit a.ts")])
        let rows = ChatTimeline.rows(session: session("working", turn: "t1"), remembered: nil, sends: [], live: live, now: now)
        XCTAssertEqual(rows.first, .steer(id: "you-0", text: "From the Mac", line: "Steered · Read by Claude"))
    }

    func testClippedReportsStillMatchTheSteer() {
        XCTAssertTrue(ChatTimeline.same("Keep the plain-text fallback for…", "Keep the plain-text fallback for anything it can't parse"))
        XCTAssertTrue(ChatTimeline.same("Two words", "Two\n words"))
        XCTAssertFalse(ChatTimeline.same("Something else", "Keep it"))
    }

    func testAFinishedTurnFoldsItsStepsAboveTheReply() {
        let live = liveTurn(working: false, steps: [.init(kind: "tool", text: "Run tests"), .init(kind: "you", text: "x")])
        let rows = ChatTimeline.rows(session: session("finished", turn: "t2", message: "Done", ago: 1), remembered: previous, sends: [], live: live, now: now)
        XCTAssertEqual(rows, [.folded(id: "worked", steps: [TurnStep(kind: "tool", text: "Run tests")]), .agent(text: "Done", atISO: iso(1), muted: false)])
    }
    /* ---------- read receipts ---------- */

    func testSentIsNotReadUntilTheAgentHasIt() {
        // The Mac took it, the chat has not started working yet: still "Sent".
        let s = send(.sent)
        let rows = ChatTimeline.rows(session: session("finished", message: "Earlier answer"), remembered: previous, sends: [s], now: now)
        XCTAssertTrue(rows.contains(.sent(s)))
    }

    func testAQueuedMessageIsReadWhenItLeavesConductorsQueue() {
        var q = queuedSend(seen: true); q.status = .sent
        let gone = ChatTimeline.rows(session: session("working", turn: "t1"), remembered: previous, sends: [q], live: liveTurn(queue: []), now: now)
        XCTAssertTrue(gone.contains(.sent(read(q))))
    }

    func testASteerIsSteeredUntilTheTranscriptShowsIt() {
        let steer = ChatSend(text: "Use the timer", date: now.addingTimeInterval(-3), answersTurn: "t1", status: .steered, mode: .steer)
        let rows = ChatTimeline.rows(session: session("working", turn: "t1"), remembered: nil, sends: [steer],
                                     live: liveTurn(steps: [.init(kind: "tool", text: "Read a.ts")]), now: now)
        XCTAssertTrue(rows.contains(.steer(id: steer.id.uuidString, text: "Use the timer", line: ChatSend.Status.steered.steerLine(at: steer.date))))
    }

    func testSteerLineCarriesItsTime() {
        let at = Date(timeIntervalSince1970: 1_700_000_000)
        let clock = at.formatted(date: .omitted, time: .shortened)
        XCTAssertEqual(ChatSend.Status.steered.steerLine(at: at), "Steered at \(clock)")
        XCTAssertEqual(ChatSend.Status.read(agent: "Claude").steerLine(at: at), "Steered at \(clock) · Read by Claude")
        XCTAssertEqual(ChatSend.Status.turnEnded.steerLine(at: at), "Steered at \(clock) · Turn ended")
        // Typed on the Mac: no time of its own.
        XCTAssertEqual(ChatSend.Status.read(agent: "Codex").steerLine(at: nil), "Steered · Read by Codex")
        // Not landed yet or refused: the ordinary line.
        XCTAssertEqual(ChatSend.Status.sending.steerLine(at: at), "Sending…")
        XCTAssertEqual(ChatSend.Status.refused("busy").steerLine(at: at), ChatSend.Status.refused("busy").line)
    }

    func testReadLine() {
        XCTAssertEqual(ChatSend.Status.read(agent: "Codex").line, "Read by Codex")
    }
    /* ---------- history ---------- */

    func testEarlierExchangesShowAboveLessWhatIsAlreadyOnScreen() {
        let s = send(.sent, turn: "t1")
        var live = liveTurn(working: false)
        live.history = [
            .init(role: "user", text: "Find out why", at: iso(900)),
            .init(role: "assistant", text: "It cuts inside a tag.", at: iso(800)),
            .init(role: "user", text: "go", at: iso(5)),          // this phone's own send: already a bubble
            .init(role: "assistant", text: "New answer", at: iso(1)), // the latest message: already shown
        ]
        let rows = ChatTimeline.rows(session: session("finished", turn: "t2", message: "New answer", ago: 1), remembered: previous, sends: [s], live: live, now: now)
        let earlier = rows.compactMap { row -> String? in if case .history(_, _, let text, _) = row { text } else { nil } }
        XCTAssertEqual(earlier, ["Find out why", "It cuts inside a tag."])
        guard case .history(_, true, _, _)? = rows.first else { return XCTFail("history first, the user's on the right") }
    }

    func testAnEmptyLiveHistoryDoesNotEraseTheCachedOne() {
        var live = liveTurn(working: false)
        live.history = []
        let cached = [LiveTurn.HistoryEntry(role: "user", text: "Cached question", at: iso(900)),
                      LiveTurn.HistoryEntry(role: "assistant", text: "Cached answer", at: iso(800))]
        let rows = ChatTimeline.rows(session: session("finished", turn: "t2", message: "New answer", ago: 1), remembered: previous, sends: [], live: live, cachedHistory: cached, now: now)
        let earlier = rows.compactMap { row -> String? in if case .history(_, _, let text, _) = row { text } else { nil } }
        XCTAssertEqual(earlier, ["Cached question", "Cached answer"])
        XCTAssertNil(ChatTimeline.firstNonEmpty(nil, []))
    }

    func testNoHistoryWithoutTheLiveTurn() {
        let rows = ChatTimeline.rows(session: session("finished", message: "Earlier answer"), remembered: previous, sends: [], now: now)
        XCTAssertFalse(rows.contains { if case .history = $0 { true } else { false } })
    }

    func testTheWorkBetweenMessagesShowsAsACountBeforeTheMessageItLedTo() {
        let history = [
            LiveTurn.HistoryEntry(role: "user", text: "Fix it"),
            LiveTurn.HistoryEntry(role: "assistant", text: "Fixed.", workBefore: 5),
            LiveTurn.HistoryEntry(role: "user", text: "Again", workBefore: 1),
            LiveTurn.HistoryEntry(role: "assistant", text: "Done."),
        ]
        let rows = ChatTimeline.merged(history, tail: [], steerTexts: [], isWorking: false)
        let shape = rows.map { row -> String in
            switch row {
            case .history(_, let fromUser, let text, _): "\(fromUser ? "you" : "agent"): \(text)"
            case .worked(_, let steps): "worked \(steps)"
            default: "?"
            }
        }
        XCTAssertEqual(shape, ["you: Fix it", "worked 5", "agent: Fixed.", "worked 1", "you: Again", "agent: Done."])
        // The latest answer is already on screen: it takes its own place, with the work behind it.
        let onScreen = ChatTimeline.merged(history, tail: [.agent(text: "Done.", atISO: "", muted: false)], steerTexts: [], isWorking: false)
        XCTAssertEqual(onScreen.count, 6)
        guard case .agent? = onScreen.last else { return XCTFail("the answer closes the chat") }
        // An older Mac sends no counts: nothing extra.
        let plain = ChatTimeline.merged([LiveTurn.HistoryEntry(role: "user", text: "Hi")], tail: [], steerTexts: [], isWorking: false)
        XCTAssertEqual(plain.count, 1)
    }

    /* ---------- order ---------- */

    func shape(_ rows: [ChatTimeline.Row]) -> [String] {
        rows.map { row in
            switch row {
            case .history(_, let fromUser, let text, _): "\(fromUser ? "you" : "agent")·h: \(text)"
            case .sent(let s): "sent: \(s.text)"
            case .agent(let text, _, let muted): "agent\(muted ? "·muted" : ""): \(text)"
            case .worked(_, let n): "worked \(n)"
            case .folded: "folded"
            case .steer(_, let text, _): "steer: \(text)"
            case .working: "working"
            case .empty: "empty"
            }
        }
    }

    func testAQueuedMessageTakenUpAfterTheTurnSitsAfterTheWorkAndAnswerBeforeIt() {
        // P1 started T1; P2 was queued behind it and the agent took it up at once, so the chat never rested.
        let p1 = ChatSend(text: "first", date: now.addingTimeInterval(-300), answersTurn: "t0", status: .sent)
        var p2 = ChatSend(text: "second", date: now.addingTimeInterval(-100), answersTurn: "t1", status: .sent, queuedBehindTurn: true)
        p2.seenInQueue = true
        var live = liveTurn(working: true)
        live.history = [
            .init(role: "user", text: "first", at: iso(300)),
            .init(role: "assistant", text: "Answer one", at: iso(120), workBefore: 7),
            .init(role: "user", text: "second", at: iso(100)),
        ]
        let remembered = RememberedMessage(text: "Answer one", atISO: iso(120), turnId: "t1")
        let rows = ChatTimeline.rows(session: session("working", turn: "t2"), remembered: remembered, sends: [p1, p2], live: live, now: now)
        XCTAssertEqual(shape(rows).prefix(5), ["sent: first", "worked 7", "agent·muted: Answer one", "sent: second", "working"])
    }

    func testHistoryKeepsTheSameIdsWhenTheWindowSlides() {
        let a = LiveTurn.HistoryEntry(role: "user", text: "alpha", at: iso(500))
        let b = LiveTurn.HistoryEntry(role: "assistant", text: "beta", at: iso(400))
        let c = LiveTurn.HistoryEntry(role: "user", text: "gamma", at: iso(300))
        let first = ChatTimeline.merged([a, b, c], tail: [], steerTexts: [], isWorking: false).map(\.id)
        let slid = ChatTimeline.merged([b, c], tail: [], steerTexts: [], isWorking: false).map(\.id)
        XCTAssertEqual(Array(first.suffix(2)), slid)
    }

    func testTheAgentsNotesAfterTheNewestMessageAreNotShownAsMessagesWhileItWorks() {
        let history: [LiveTurn.HistoryEntry] = [
            .init(role: "user", text: "do it"),
            .init(role: "assistant", text: "Looking into it"),
        ]
        let rows = ChatTimeline.merged(history, tail: [], steerTexts: [], isWorking: true)
        XCTAssertEqual(shape(rows), ["you·h: do it"])
    }

    func testAClippedFeedStillShowsTheWorkBeforeASteer() {
        let steered = ChatSend(text: "also this", date: now.addingTimeInterval(-10), answersTurn: "t1", status: .steered, mode: .steer)
        let steps = (0..<5).map { TurnStep(kind: "tool", text: "step \($0)") }
        let rows = ChatTimeline.turn(steps: steps, steers: [steered], truncated: true, total: 80)
        XCTAssertEqual(shape(rows).first, "worked 75")
    }
}
