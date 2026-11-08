import SqueakCore
import XCTest
@testable import SqueakUI

final class AnswerCardTests: XCTestCase {
    private func session(state: String, tool: String?) -> PhoneSnapshot.Session {
        .init(key: "k", conductorSessionId: "id", label: "repo · branch", agent: "claude", state: state, lastActivityAt: "2026-10-19T10:00:00Z",
              detail: nil, git: nil, contextPercent: nil, turnId: "t", message: nil, choices: nil, activity: nil,
              title: nil,
              question: tool.map { .init(toolUseId: $0, questions: [.init(question: "Which?", header: nil, multiSelect: false, options: [.init(label: "A", description: nil)])]) })
    }

    func testLiveWhileTheSameCallIsStillPending() {
        XCTAssertEqual(AnswerCard.standing(shown: "t1", session: session(state: "awaiting_input", tool: "t1"), answeredHere: false), .live)
    }

    func testAnswerElsewhereWhenTheSessionMovedOn() {
        XCTAssertEqual(AnswerCard.standing(shown: "t1", session: session(state: "finished", tool: nil), answeredHere: false), .answeredElsewhere)
        XCTAssertEqual(AnswerCard.standing(shown: "t1", session: session(state: "awaiting_input", tool: nil), answeredHere: false), .answeredElsewhere)
    }

    func testAReplacedQuestionIsNotTheOneShown() {
        XCTAssertEqual(AnswerCard.standing(shown: "t1", session: session(state: "awaiting_input", tool: "t2"), answeredHere: false), .answeredElsewhere)
    }

    func testAnAnswerThisPhoneMadeIsNotElsewhere() {
        XCTAssertEqual(AnswerCard.standing(shown: "t1", session: session(state: "working", tool: nil), answeredHere: true), .answeredHere)
    }

    func testACardWithoutAnIdStaysLiveWhileAnyQuestionIsPending() {
        XCTAssertEqual(AnswerCard.standing(shown: nil, session: session(state: "awaiting_input", tool: "t9"), answeredHere: false), .live)
    }
}
