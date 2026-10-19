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
        XCTAssertEqual(ChatTimeline.workingLabel([tool("Frobnicate")]), "Working…")
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
        XCTAssertEqual(ChatSend.Status.notConfirmed.line, "Not confirmed")
        XCTAssertEqual(ChatSend.Status.refused("Waiting inside Conductor.").line, "Not sent: Waiting inside Conductor.")
    }

    func testTwoSendsWhileWorkingKeepBothBubblesInOrderThenOneWorkingRow() {
        let a = send(.sent, ago: 120), b = send(.sending, ago: 5)
        let rows = ChatTimeline.rows(session: session("working", turn: "t2"), remembered: previous, sends: [a, b], now: now)
        XCTAssertEqual(rows, [.agent(text: "Earlier answer", atISO: previous.atISO, muted: true), .sent(read(a)), .sent(b), .working(label: "Starting…")])
    }

    func testNotConfirmedStillCountsAsWaiting() {
        let rows = ChatTimeline.rows(session: session("finished", message: "Earlier answer"), remembered: previous, sends: [send(.notConfirmed)], now: now)
        XCTAssertTrue(rows.contains { if case .working = $0 { true } else { false } })
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
        XCTAssertEqual(ChatSend.Status.refused("busy").line, "Not sent: busy")
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
            .steer(id: steer.id.uuidString, text: "Keep the fallback", line: "Read by Claude"),
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
        XCTAssertEqual(rows.first, .steer(id: "you-0", text: "From the Mac", line: "Read by Claude"))
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
        XCTAssertTrue(rows.contains(.steer(id: steer.id.uuidString, text: "Use the timer", line: "Steered into the current turn")))
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

    func testNoHistoryWithoutTheLiveTurn() {
        let rows = ChatTimeline.rows(session: session("finished", message: "Earlier answer"), remembered: previous, sends: [], now: now)
        XCTAssertFalse(rows.contains { if case .history = $0 { true } else { false } })
    }
}
