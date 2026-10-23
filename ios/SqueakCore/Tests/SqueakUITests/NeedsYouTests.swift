import SqueakCore
import XCTest
@testable import SqueakUI

/// The Needs you page's decision cards: what each kind says, which controls it offers, how many are full,
/// and where an answer sent from the card stands.
final class NeedsYouTests: XCTestCase {
    private func chat(_ key: String, _ state: String, at: String = "2026-10-19T10:00:00Z", conductor: Bool = true,
                      detail: String? = nil, message: String? = nil, choices: PhoneSnapshot.Choices? = nil,
                      question: PhoneSnapshot.Question? = nil, asks: String? = nil, turn: String = "t1") -> PhoneSnapshot.Session {
        var s = PhoneSnapshot.Session(
            key: key, conductorSessionId: conductor ? key : nil, label: "farm · \(key)", agent: "claude", state: state, lastActivityAt: at,
            detail: detail, git: nil, contextPercent: nil, turnId: turn, message: message, choices: choices, title: key, question: question)
        s.asks = asks
        return s
    }

    private let lettered = PhoneSnapshot.Choices(
        question: "Arm it?", options: [.init(letter: "A", title: "Now"), .init(letter: "B", title: "Later")], recommended: "B")
    private let ask = PhoneSnapshot.Question(toolUseId: "tu", questions: [
        .init(question: "Which?", header: nil, multiSelect: false, options: [.init(label: "X", description: nil)])])

    func testLetteredChoicesCardAsksTheQuestionAndOffersOptionsReplyAndOpen() {
        let card = NeedsYou.card(for: chat("a", "finished", message: "Done.\n\n**Arm it?**\n\n**A) Now.** x\n\n**B) Later.** y", choices: lettered, asks: "Arm it?"))
        XCTAssertEqual(card.kind, .choices)
        XCTAssertEqual(card.stateWord, "needs an answer")
        XCTAssertEqual(card.heading, "Arm it?")
        XCTAssertEqual(card.controls, [.choices, .reply, .openChat])
        // The question and the lettered paragraphs are controls, not prose.
        XCTAssertEqual(card.context, "Done.")
    }

    func testPlainQuestionHasAReplyFieldAndNoOptions() {
        let card = NeedsYou.card(for: chat("a", "finished", message: "Tests pass.\n\nWant me to open a PR?", asks: "Want me to open a PR?"))
        XCTAssertEqual(card.kind, .asks)
        XCTAssertEqual(card.controls, [.reply, .openChat])
        XCTAssertEqual(card.context, "Tests pass.")
    }

    func testApprovalSaysWhereToApproveAndOffersNoDeadButtons() {
        let card = NeedsYou.card(for: chat("a", "awaiting_approval", detail: "Codex needs your permission to run a command", message: "Codex needs your permission to run a command"))
        XCTAssertEqual(card.kind, .approval)
        XCTAssertEqual(card.stateWord, "needs approval")
        XCTAssertEqual(card.heading, "Codex needs your permission to run a command")
        XCTAssertEqual(card.controls, [.approvalNote, .openChat])
        XCTAssertNil(card.context)
    }

    func testQuestionAndPlanUseTheChatsOwnAnswerControlsAndNoReply() {
        let q = NeedsYou.card(for: chat("a", "awaiting_input", question: ask))
        XCTAssertEqual(q.kind, .question)
        XCTAssertNil(q.heading)
        XCTAssertEqual(q.controls, [.answerQuestion, .openChat])
        let plan = NeedsYou.card(for: chat("a", "awaiting_input", question: .init(toolUseId: "tu", questions: [], plan: "1. Do it")))
        XCTAssertEqual(plan.kind, .plan)
        XCTAssertEqual(plan.stateWord, "needs approval")
        XCTAssertEqual(plan.controls, [.plan, .openChat])
    }

    func testABlockedChatWithNothingToReadOnlySendsYouToTheMac() {
        let card = NeedsYou.card(for: chat("a", "awaiting_input"))
        XCTAssertEqual(card.kind, .blocked)
        XCTAssertEqual(card.controls, [.approvalNote, .openChat])
    }

    func testAChatThePhoneCannotReplyToGetsNoReplyField() {
        XCTAssertEqual(NeedsYou.card(for: chat("a", "finished", conductor: false, message: "Q?", asks: "Q?")).controls, [.openChat])
    }

    func testALongMessageIsCutAtASentenceAndOffersTheFullText() {
        let sentence = "The check runs before a chat starts and compares paths. "
        let long = String(repeating: sentence, count: 12)
        let card = NeedsYou.card(for: chat("a", "finished", message: long + "\n\nShip it?", asks: "Ship it?"))
        XCTAssertTrue(card.hasMore)
        XCTAssertLessThanOrEqual(card.context!.count, 210)
        XCTAssertTrue(card.context!.hasSuffix("…"))
        XCTAssertTrue(card.full!.count > card.context!.count)
        let short = NeedsYou.card(for: chat("a", "finished", message: "Short.\n\nShip it?", asks: "Ship it?"))
        XCTAssertFalse(short.hasMore)
    }

    func testOrderPutsApprovalsFirstThenTheOldestWaiting() {
        let sessions = [
            chat("new-q", "finished", at: "2026-10-19T12:00:00Z", message: "Q?", asks: "Q?"),
            chat("old-q", "finished", at: "2026-10-19T09:00:00Z", message: "Q?", asks: "Q?"),
            chat("approve", "awaiting_approval", at: "2026-10-19T11:00:00Z"),
            chat("working", "working", at: "2026-10-19T08:00:00Z"),
        ]
        XCTAssertEqual(NeedsYou.ordered(sessions).map(\.key), ["approve", "old-q", "new-q"])
    }

    func testLayoutIsOneOrTwoFullThenRows() {
        XCTAssertEqual(NeedsYou.layout(count: 0), .init(full: 0, compact: 0))
        XCTAssertEqual(NeedsYou.layout(count: 1), .init(full: 1, compact: 0))
        XCTAssertEqual(NeedsYou.layout(count: 2), .init(full: 2, compact: 0))
        XCTAssertEqual(NeedsYou.layout(count: 5), .init(full: 2, compact: 3))
        XCTAssertEqual(NeedsYou.layout(count: 5).moreLine, "3 more waiting")
        XCTAssertNil(NeedsYou.layout(count: 2).moreLine)
    }

    func testTheEmptyHintSaysWhatIsRunning() {
        XCTAssertEqual(NeedsYou.hint([chat("a", "working"), chat("b", "working"), chat("c", "working"), chat("d", "idle")]), "3 working")
        XCTAssertEqual(NeedsYou.hint([chat("d", "idle")]), "Nothing is running either.")
    }

    func testOutcomeFollowsOnlyTheSendForThisTurn() {
        let session = chat("a", "finished", message: "Q?", asks: "Q?", turn: "t1")
        func send(_ status: ChatSend.Status, turn: String?) -> ChatSend { .init(text: "A", date: Date(), answersTurn: turn, status: status) }
        XCTAssertEqual(NeedsYou.outcome(of: [], for: session), .none)
        // An earlier turn's message is not this answer.
        XCTAssertEqual(NeedsYou.outcome(of: [send(.sent, turn: "t0")], for: session), .none)
        XCTAssertEqual(NeedsYou.outcome(of: [send(.sending, turn: "t1")], for: session), .sending)
        XCTAssertEqual(NeedsYou.outcome(of: [send(.sent, turn: "t1")], for: session).line, "Sent · waiting for the agent")
        let refused = send(.refused("your Mac refused"), turn: "t1")
        XCTAssertEqual(NeedsYou.outcome(of: [refused], for: session), .failed(line: refused.status.line, sendId: refused.id))
        let unsure = send(.notConfirmed, turn: "t1")
        if case .failed(let line, _) = NeedsYou.outcome(of: [unsure], for: session) { XCTAssertTrue(line.hasPrefix("Couldn't confirm")) } else { XCTFail("unconfirmed is not sent") }
    }
}
