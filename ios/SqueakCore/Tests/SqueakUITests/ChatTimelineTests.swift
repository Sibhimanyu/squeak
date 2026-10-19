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
        XCTAssertEqual(rows, [.agent(text: "Earlier answer", atISO: previous.atISO, muted: true), .working(label: "Running tests…")])
        XCTAssertEqual(ChatTimeline.workingLabel([tool("Read src/a.ts")]), "Reading code…")
        XCTAssertEqual(ChatTimeline.workingLabel([.init(kind: "thinking", text: "hm")]), "Thinking…")
        XCTAssertEqual(ChatTimeline.workingLabel([tool("Frobnicate")]), "Working…")
    }

    func testReplyReplacesTheWorkingRowAndTheBubbleStaysOnce() {
        let s = send(.sent)
        let rows = ChatTimeline.rows(session: session("finished", turn: "t2", message: "New answer", ago: 1), remembered: previous, sends: [s], now: now)
        // The send answered t1, so it sits before t2's reply; no working row, no duplicate, no empty.
        XCTAssertEqual(rows, [.sent(s), .agent(text: "New answer", atISO: iso(1), muted: false)])
    }

    func testStillWorkingKeepsBubbleAfterThePreviousMessage() {
        let s = send(.sent)
        let rows = ChatTimeline.rows(session: session("working", turn: "t2"), remembered: previous, sends: [s], now: now)
        XCTAssertEqual(rows, [.agent(text: "Earlier answer", atISO: previous.atISO, muted: true), .sent(s), .working(label: "Starting…")])
    }

    func testRefusedSendShowsItsReasonAndNoWorkingRow() {
        let s = send(.refused("Waiting inside Conductor."))
        let rows = ChatTimeline.rows(session: session("finished", message: "Earlier answer"), remembered: previous, sends: [s], now: now)
        XCTAssertEqual(rows, [.agent(text: "Earlier answer", atISO: iso(600), muted: false), .sent(s)])
    }

    func testAnUnansweredSendGivesUpAfterTenMinutes() {
        let s = send(.sent, ago: 700)
        let rows = ChatTimeline.rows(session: session("finished", message: "Earlier answer"), remembered: previous, sends: [s], now: now)
        XCTAssertFalse(rows.contains { if case .working = $0 { true } else { false } })
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
        XCTAssertEqual(rows, [.agent(text: "Earlier answer", atISO: previous.atISO, muted: true), .sent(a), .sent(b), .working(label: "Starting…")])
    }

    func testNotConfirmedStillCountsAsWaiting() {
        let rows = ChatTimeline.rows(session: session("finished", message: "Earlier answer"), remembered: previous, sends: [send(.notConfirmed)], now: now)
        XCTAssertTrue(rows.contains { if case .working = $0 { true } else { false } })
    }
}
