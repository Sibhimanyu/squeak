import SqueakCore
import XCTest
@testable import SqueakUI

/// Where a chat puts what you sent: by when it happened, never at the end because it was not matched by words.
final class ChatOrderingTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    func iso(_ ago: TimeInterval) -> String {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: now.addingTimeInterval(-ago))
    }
    func session(_ state: String = "finished", turn: String? = "t2", message: String? = "Answer", ago: TimeInterval = 50,
                 lastUser: PhoneSnapshot.Session.LastUser? = nil) -> PhoneSnapshot.Session {
        var s = PhoneSnapshot.Session(
            key: "k", conductorSessionId: "c1", label: "repo · branch", agent: "claude", state: state,
            lastActivityAt: iso(ago), detail: nil, git: nil, contextPercent: nil, turnId: turn, message: message, choices: nil)
        s.lastUser = lastUser
        return s
    }
    func send(_ status: ChatSend.Status = .sent, text: String = "go", turn: String? = "t1", ago: TimeInterval) -> ChatSend {
        ChatSend(text: text, date: now.addingTimeInterval(-ago), answersTurn: turn, status: status)
    }
    func user(_ text: String, _ ago: TimeInterval) -> LiveTurn.HistoryEntry { .init(role: "user", text: text, at: iso(ago)) }
    func agent(_ text: String, _ ago: TimeInterval) -> LiveTurn.HistoryEntry { .init(role: "assistant", text: text, at: iso(ago)) }

    /// A row's kind and text, for reading an order at a glance.
    func shape(_ rows: [ChatTimeline.Row]) -> [String] {
        rows.map {
            switch $0 {
            case .sent(let s): "sent:\(s.text)"
            case .agent(let t, _, _): "agent:\(t)"
            case .history(_, let fromUser, let t, _): "\(fromUser ? "user" : "past"):\(t)"
            case .worked: "worked"
            case .folded: "folded"
            case .steer: "steer"
            case .working: "working"
            case .empty: "empty"
            }
        }
    }
    func rows(_ session: PhoneSnapshot.Session, sends: [ChatSend], history: [LiveTurn.HistoryEntry]?) -> [ChatTimeline.Row] {
        ChatTimeline.rows(session: session, remembered: nil, sends: sends, cachedHistory: history, now: now)
    }

    func testHappyPathPromptThenAnswerOnce() {
        let history = [user("go", 100), agent("Answer", 50)]
        let r = rows(session(), sends: [send(ago: 100)], history: history)
        XCTAssertEqual(shape(r), ["sent:go", "agent:Answer"])
    }

    func testDeliveredSendWithDifferentWordsIsNotShownTwiceOrLast() {
        // The Mac wrote the message with a brief in front; the words differ, the time is right.
        let history = [user("Earlier ask", 900), agent("Earlier answer", 800), user("[brief] go", 97), agent("Answer", 50)]
        let r = rows(session(), sends: [send(ago: 100)], history: history)
        XCTAssertEqual(shape(r), ["user:Earlier ask", "past:Earlier answer", "sent:go", "agent:Answer"])
    }

    func testUnconfirmedSendThatNeverArrivedSitsWhereItHappened() {
        let history = [user("other", 500), agent("Answer", 400)]
        let r = rows(session(turn: "t1", ago: 400), sends: [send(.notConfirmed, ago: 1000)], history: history)
        XCTAssertEqual(shape(r), ["sent:go", "user:other", "agent:Answer"])
    }

    func testRefusedSendBetweenTwoExchanges() {
        let history = [user("one", 900), agent("a1", 800), user("two", 100), agent("a2", 50)]
        let r = rows(session(message: "a2"), sends: [send(.refused("no"), ago: 300)], history: history)
        XCTAssertEqual(shape(r), ["user:one", "past:a1", "sent:go", "user:two", "agent:a2"])
    }

    func testSameTurnMismatchGoesBeforeTheAnswerThatCameAfterIt() {
        let history = [user("x", 1000), agent("Answer", 200)]
        // The send names the turn the chat is still on, yet the answer is newer than it.
        let r = rows(session(turn: "t1", ago: 200), sends: [send(.refused("no"), turn: "t1", ago: 300)], history: history)
        XCTAssertEqual(shape(r), ["user:x", "sent:go", "agent:Answer"])
    }

    func testWorkBeforeTheAnswerStaysWithTheAnswer() {
        let history = [user("x", 1000), LiveTurn.HistoryEntry(role: "assistant", text: "Answer", at: iso(200), workBefore: 4)]
        let r = rows(session(turn: "t1", ago: 200), sends: [send(.refused("no"), turn: "t1", ago: 300)], history: history)
        XCTAssertEqual(shape(r), ["user:x", "sent:go", "worked", "agent:Answer"])
    }

    func testOnlyAReallyNewSendGoesLast() {
        let history = [user("x", 1000), agent("Answer", 200)]
        let fresh = send(.refused("no"), turn: "t2", ago: 2)
        let r = rows(session(turn: "t2", ago: 200), sends: [fresh], history: history)
        XCTAssertEqual(shape(r).first, "user:x")
        XCTAssertEqual(shape(r)[1], "agent:Answer")
        XCTAssertEqual(shape(r)[2], "sent:go")
    }

    func testFailedSendOlderThanADayIsDropped() {
        let old = send(.notConfirmed, ago: ChatTimeline.failedKeep + 60)
        let r = rows(session(), sends: [old], history: [user("x", 1000), agent("Answer", 50)])
        XCTAssertFalse(shape(r).contains("sent:go"))
    }

    func testBubbleDoesNotSaySentForeverWhenNoAnswerFollowed() {
        // Delivered, the chat went back to rest on the same turn: nothing answered it.
        let r = ChatTimeline.rows(session: session(turn: "t1", message: "Old", ago: 300), remembered: nil,
                                  sends: [send(ago: 200)], cachedHistory: nil, now: now)
        guard case .sent(let s)? = r.first(where: { if case .sent = $0 { true } else { false } }) else { return XCTFail("bubble") }
        XCTAssertEqual(s.status, .turnEnded)
        XCTAssertEqual(s.status.line, "Turn ended")
    }

    func testAnsweredSendStillSaysRead() {
        let r = ChatTimeline.rows(session: session(turn: "t2"), remembered: nil, sends: [send(ago: 200)], cachedHistory: nil, now: now)
        guard case .sent(let s)? = r.first(where: { if case .sent = $0 { true } else { false } }) else { return XCTFail("bubble") }
        XCTAssertEqual(s.status, .read(agent: "Claude"))
    }

    /* ---------- an answer typed at the laptop ---------- */

    func testLaptopAnswerShowsAsAYouRowBeforeTheReply() {
        let last = PhoneSnapshot.Session.LastUser(text: "from the laptop", at: iso(20))
        let r = rows(session(turn: "t3", message: "Reply", ago: 10, lastUser: last), sends: [], history: [user("one", 900), agent("a1", 800)])
        XCTAssertEqual(shape(r), ["user:one", "past:a1", "user:from the laptop", "agent:Reply"])
    }

    func testLaptopAnswerWithNoHistoryAtAll() {
        let last = PhoneSnapshot.Session.LastUser(text: "from the laptop", at: iso(20))
        let r = rows(session(lastUser: last), sends: [], history: nil)
        XCTAssertEqual(shape(r), ["user:from the laptop", "agent:Answer"])
    }

    func testLastUserAlreadyInTheHistoryOrSentFromThisPhoneIsNotRepeated() {
        let last = PhoneSnapshot.Session.LastUser(text: "go", at: iso(100))
        let inHistory = rows(session(lastUser: last), sends: [], history: [user("go", 99), agent("Answer", 50)])
        XCTAssertEqual(shape(inHistory), ["user:go", "agent:Answer"])
        let mine = rows(session(lastUser: .init(text: "[brief] go", at: iso(97))), sends: [send(ago: 100)], history: [agent("Answer", 50)])
        XCTAssertEqual(shape(mine).filter { $0.hasSuffix("go") }, ["sent:go"])
    }

    func testARepeatedPromptAtTheLaptopIsNotHiddenByAnOlderOne() {
        let last = PhoneSnapshot.Session.LastUser(text: "continue", at: iso(20))
        let r = rows(session(ago: 10, lastUser: last), sends: [], history: [user("continue", 5000), agent("a", 4900)])
        XCTAssertEqual(shape(r).filter { $0 == "user:continue" }.count, 2)
    }

    /* ---------- the outbox ---------- */

    func testOutboxDropsOldFailuresAndSettlesUnconfirmedFromHistory() {
        let old = send(.refused("no"), ago: ChatTimeline.failedKeep + 1)
        let proven = send(.notConfirmed, text: "go", ago: 100)
        let never = send(.notConfirmed, text: "lost", ago: 3000)
        let fine = send(.sent, text: "ok", ago: 100)
        let history = [user("older", 4000), agent("x", 3900), user("go", 99), agent("y", 1000)]
        let kept = OutboxPolicy.prune([old, proven, never, fine], history: history, now: now)
        XCTAssertEqual(kept.map(\.text), ["go", "lost", "ok"])
        XCTAssertEqual(kept[0].status, .sent)
        guard case .refused = kept[1].status else { return XCTFail("history covers its time and has no sign of it") }
        XCTAssertEqual(kept[2].status, .sent)
        // History that does not reach back to the send proves nothing.
        let unknown = OutboxPolicy.prune([send(.notConfirmed, text: "lost", ago: 7000)], history: history, now: now)
        XCTAssertEqual(unknown[0].status, .notConfirmed)
    }
}
