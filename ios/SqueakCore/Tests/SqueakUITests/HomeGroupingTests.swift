import SqueakCore
import XCTest
@testable import SqueakUI

/// Home: chats grouped by project or by state.
final class HomeGroupingTests: XCTestCase {
    private func chat(_ key: String, _ state: String, repo: String = "storefront", at: String = "2026-10-19T10:00:00Z",
                      choices: PhoneSnapshot.Choices? = nil, question: PhoneSnapshot.Question? = nil,
                      message: String? = nil) -> PhoneSnapshot.Session {
        .init(key: key, conductorSessionId: key, label: "\(repo) · \(key)", agent: "claude", state: state, lastActivityAt: at,
              detail: nil, git: nil, contextPercent: nil, turnId: "t", message: message, choices: choices, title: key, question: question)
    }

    func testStatusListsOnlyStatesWithChatsInAttentionOrder() {
        let chats = [chat("a", "awaiting_input"), chat("b", "awaiting_approval"), chat("c", "working"), chat("d", "finished"), chat("e", "idle")]
        XCTAssertEqual(Presentation.statusGroups(chats).map(\.filter), [.needsYou, .working, .done, .idle])
        XCTAssertEqual(Presentation.statusGroups(chats).map(\.count), [2, 1, 1, 1])
        XCTAssertEqual(Presentation.statusGroups(chats + [chat("f", "error")]).map(\.filter), [.needsYou, .working, .done, .error, .idle])
        XCTAssertEqual(Presentation.statusGroups([chat("c", "working")]).map(\.filter), [.working])
        XCTAssertTrue(Presentation.inFilter(chat("e", "idle"), .idle))
        XCTAssertFalse(Presentation.inFilter(chat("f", "error"), .idle))
    }

    func testHeaderCountsSessionsAndWhatIsWorking() {
        XCTAssertEqual(Presentation.headerCount([]), "Nothing active")
        XCTAssertEqual(Presentation.headerCount([chat("a", "idle")]), "1 session")
        let six = [chat("a", "working"), chat("b", "working"), chat("c", "working"), chat("d", "idle"), chat("e", "idle"), chat("f", "error")]
        XCTAssertEqual(Presentation.headerCount(six), "6 sessions · 3 working")
    }

    func testProjectSummaryNamesWhatIsGoingOnInAttentionOrder() {
        XCTAssertEqual(Presentation.projectSummary([chat("a", "error"), chat("b", "working"), chat("c", "idle")]), "1 working · 1 error")
        XCTAssertEqual(Presentation.projectSummary([chat("a", "awaiting_input"), chat("b", "awaiting_approval")]), "2 need you")
        XCTAssertEqual(Presentation.projectSummary([chat("a", "awaiting_input"), chat("b", "finished")]), "1 needs you · 1 done")
        XCTAssertEqual(Presentation.projectSummary([chat("a", "idle"), chat("b", "idle")]), "2 idle")
    }

    func testProjectsGroupByRepoInAttentionOrder() {
        let chats = [
            chat("t1", "working", repo: "squeak", at: "2026-10-19T10:30:00Z"),
            chat("p1", "finished", repo: "storefront", at: "2026-10-19T08:00:00Z"),
            chat("p2", "awaiting_input", repo: "storefront", at: "2026-10-19T09:00:00Z"),
            chat("i1", "idle", repo: "compass"),
            chat("s1", "finished", repo: "atlas", at: "2026-10-19T10:00:00Z"),
        ]
        let projects = Presentation.projects(chats)
        XCTAssertEqual(projects.map(\.name), ["storefront", "atlas", "squeak", "compass"])
        XCTAssertEqual(projects.first?.sessions.map(\.key), ["p2", "p1"])
    }

    func testAChatWithoutARepoIsItsOwnProject() {
        var loose = chat("x", "working")
        loose = .init(key: "x", conductorSessionId: nil, label: "scratch", agent: "codex", state: "working", lastActivityAt: "",
                      detail: nil, git: nil, contextPercent: nil, turnId: nil, message: nil, choices: nil)
        XCTAssertEqual(Presentation.projectName(loose), "scratch")
    }

    func testOneTapAnswersOnlyWhereThePhoneCanAnswer() {
        let prompt = PhoneSnapshot.Question.Prompt(question: "Retry how?", header: nil, multiSelect: false,
                                                   options: [.init(label: "Automatically", description: nil), .init(label: "Ask the customer", description: nil)])
        let asked = chat("q", "awaiting_input", question: .init(toolUseId: "toolu_1", questions: [prompt]))
        XCTAssertEqual(Presentation.quickAnswers(asked), [.option(label: "Automatically"), .option(label: "Ask the customer")])
        XCTAssertEqual(Presentation.ask(asked), "Retry how?")
        // A plan, several questions, or multi-select: open the chat instead.
        XCTAssertEqual(Presentation.quickAnswers(chat("p", "awaiting_input", question: .init(toolUseId: "t", questions: [], plan: "Do it"))), [])
        XCTAssertEqual(Presentation.quickAnswers(chat("m", "awaiting_input", question: .init(toolUseId: "t", questions: [prompt, prompt]))), [])
        // Lettered options on a finished chat go out as a reply; held inside Conductor, they cannot.
        let choices = PhoneSnapshot.Choices(question: "Which?", options: [.init(letter: "A", title: "One"), .init(letter: "B", title: "Two")], recommended: "A")
        XCTAssertEqual(Presentation.quickAnswers(chat("f", "finished", choices: choices)).map(\.title), ["A  One", "B  Two"])
        XCTAssertEqual(Presentation.quickAnswers(chat("w", "awaiting_input", choices: choices)), [])
        XCTAssertEqual(Presentation.ask(chat("a", "awaiting_approval")), "Wants approval for a tool call. Answer it on your Mac.")
    }

    func testAPreviewShowsTheMostUrgentChatsAndCountsTheRest() {
        let chats = [chat("i", "idle", at: "2026-10-19T10:05:00Z"), chat("w", "working", at: "2026-10-19T10:04:00Z"),
                     chat("n", "awaiting_input", at: "2026-10-19T09:00:00Z"), chat("d", "finished", at: "2026-10-19T10:00:00Z")]
        let two = Presentation.preview(chats)
        XCTAssertEqual(two.shown.map(\.key), ["n", "d"])
        XCTAssertEqual(two.more, 2)
        let three = Presentation.preview(chats, limit: Presentation.previewLimit(for: .needsYou))
        XCTAssertEqual(three.shown.map(\.key), ["n", "d", "w"])
        XCTAssertEqual(three.more, 1)
        XCTAssertEqual(Presentation.previewLimit(for: .working), 2)
        XCTAssertEqual(Presentation.previewLimit(for: nil), 2)
        // Fewer chats than the limit: all of them, and nothing is said about the rest.
        let one = Presentation.preview([chat("a", "idle")])
        XCTAssertEqual(one.shown.map(\.key), ["a"])
        XCTAssertEqual(one.more, 0)
        XCTAssertEqual(Presentation.preview([]).shown.count, 0)
    }

    func testMoreLineIsSilentUnlessSomethingIsHidden() {
        XCTAssertNil(Presentation.moreLine(0))
        XCTAssertEqual(Presentation.moreLine(1), "1 more session")
        XCTAssertEqual(Presentation.moreLine(3), "3 more sessions")
    }

    func testPreviewDetailSpeaksOnlyForWhatWaitsFailedOrFinished() {
        XCTAssertEqual(Presentation.previewDetail(chat("a", "awaiting_approval"), finished: false),
                       "Wants approval for a tool call. Answer it on your Mac.")
        XCTAssertNil(Presentation.previewDetail(chat("w", "working"), finished: true))
        XCTAssertNil(Presentation.previewDetail(chat("i", "idle"), finished: true))
        // An error the Mac gave no reason for says nothing more than its state word.
        XCTAssertNil(Presentation.previewDetail(chat("e", "error"), finished: true))
        let done = chat("d", "finished", message: "## Tests pass\nAll 66 green.")
        XCTAssertNil(Presentation.previewDetail(done, finished: false))
        XCTAssertEqual(Presentation.previewDetail(done, finished: true), "Tests pass")
    }

    func testTheNeedsYouBadgeCountsOnlyBlockedChats() {
        XCTAssertEqual(Presentation.needsYouCount([]), 0)
        XCTAssertEqual(Presentation.needsYouCount([chat("a", "working"), chat("b", "finished"), chat("c", "error")]), 0)
        XCTAssertEqual(Presentation.needsYouCount([chat("a", "awaiting_input"), chat("b", "awaiting_approval"), chat("c", "idle")]), 2)
    }
}
