import SqueakCore
import XCTest
@testable import SqueakUI

final class SmartSearchTests: XCTestCase {
    private var calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        calendar.firstWeekday = 2
        return calendar
    }()
    /// Wednesday 2026-11-04, 15:00 UTC.
    private let now = Date(timeIntervalSince1970: 1_793_804_400)

    private func chat(_ key: String, _ state: String = "finished", repo: String = "storefront", branch: String = "main", agent: String = "claude",
                      title: String? = nil, message: String? = nil, ago hours: Double = 1) -> PhoneSnapshot.Session {
        let at = ISO8601DateFormatter().string(from: now.addingTimeInterval(-hours * 3600))
        return .init(key: key, conductorSessionId: key, label: "\(repo) · \(branch)", agent: agent, state: state, lastActivityAt: at,
                     detail: nil, git: nil, contextPercent: nil, turnId: "t", message: message, choices: nil, title: title ?? key)
    }

    private func keys(_ query: String, _ sessions: [PhoneSnapshot.Session]) -> [String] {
        let parsed = SmartSearch.parse(query)
        return SmartSearch.results(parsed, active: sessions, older: [], now: now, calendar: calendar).active.map(\.key)
    }

    func testStateSynonymsAndPhrases() {
        XCTAssertEqual(SmartSearch.parse("needs you").tokens, [.state(.needsYou)])
        XCTAssertEqual(SmartSearch.parse("Need You").tokens, [.state(.needsYou)])
        for word in ["waiting", "blocked", "question"] { XCTAssertEqual(SmartSearch.parse(word).tokens, [.state(.needsYou)], word) }
        for word in ["working", "running"] { XCTAssertEqual(SmartSearch.parse(word).tokens, [.state(.working)], word) }
        for word in ["unread", "done", "finished"] { XCTAssertEqual(SmartSearch.parse(word).tokens, [.state(.done)], word) }
        for word in ["error", "failed"] { XCTAssertEqual(SmartSearch.parse(word).tokens, [.state(.error)], word) }
        XCTAssertEqual(SmartSearch.parse("idle").tokens, [.state(.idle)])
        XCTAssertTrue(SmartSearch.parse("needs you").terms.isEmpty, "the phrase is one token, not two words")
    }

    func testAgentsDaysAndProjectPrefix() {
        let query = SmartSearch.parse("claude codex today project:Stor in:api login")
        XCTAssertEqual(query.tokens, [.agent("claude"), .agent("codex"), .day(.today)])
        XCTAssertEqual(query.projectPrefixes, ["stor", "api"])
        XCTAssertEqual(query.terms, ["login"])
        XCTAssertEqual(SmartSearch.parse("this week").tokens, [.day(.thisWeek)])
        XCTAssertEqual(SmartSearch.parse("today yesterday").tokens, [.day(.yesterday)], "the last day typed wins")
    }

    func testFoldingIgnoresCaseAndDiacritics() {
        let list = [chat("a", title: "Café menu"), chat("b", title: "Other")]
        XCTAssertEqual(keys("CAFE", list), ["a"])
        XCTAssertEqual(keys("café", list), ["a"])
    }

    func testFreeTextWordsAreAllRequiredAcrossFields() {
        let list = [
            chat("a", repo: "storefront", branch: "fix-login", title: "Payments", message: "I rewrote the retry loop"),
            chat("b", repo: "storefront", branch: "main", title: "Payments", message: "nothing"),
        ]
        XCTAssertEqual(keys("payments retry", list), ["a"], "title and last message together")
        XCTAssertEqual(keys("payments fix-login", list), ["a"], "branch")
        XCTAssertEqual(keys("storefront", list).sorted(), ["a", "b"], "project")
        XCTAssertEqual(keys("payments zebra", list), [])
    }

    func testQuestionTextIsSearched() {
        var asking = chat("q", "awaiting_input")
        asking.asks = "Which database should it use?"
        XCTAssertEqual(keys("database", [asking, chat("z")]), ["q"])
    }

    func testStatesAreAnOrAndKindsAreAnAnd() {
        let list = [chat("w", "working", agent: "claude"), chat("d", "finished", agent: "codex"), chat("e", "error", agent: "claude"),
                    chat("n", "awaiting_input", agent: "codex")]
        XCTAssertEqual(Set(keys("working done", list)), ["w", "d"])
        XCTAssertEqual(Set(keys("working done codex", list)), ["d"])
        XCTAssertEqual(Set(keys("blocked", list)), ["n"])
        XCTAssertEqual(Set(keys("failed claude", list)), ["e"])
    }

    func testProjectPrefixAndExactChip() {
        let list = [chat("a", repo: "storefront"), chat("b", repo: "store-admin"), chat("c", repo: "api")]
        XCTAssertEqual(Set(keys("project:store", list)), ["a", "b"])
        XCTAssertEqual(Set(keys("in:sto in:ap", list)), ["a", "b", "c"])
        let chip = SmartQuery().adding([.project("api")])
        XCTAssertEqual(SmartSearch.results(chip, active: list, older: [], now: now, calendar: calendar).active.map(\.key), ["c"])
    }

    func testDaysUseTheInjectedNow() {
        // now is 15:00 on Wednesday: 2 h ago is today, 20 h ago is yesterday, 40 h ago is Monday night (this week), 5 days ago is last week.
        let list = [chat("t", ago: 2), chat("y", ago: 20), chat("w", ago: 40), chat("old", ago: 24 * 5)]
        XCTAssertEqual(keys("today", list), ["t"])
        XCTAssertEqual(keys("yesterday", list), ["y"])
        XCTAssertEqual(Set(keys("this week", list)), ["t", "y", "w"])
        XCTAssertFalse(keys("this week", list).contains("old"))
    }

    func testMatchesAreNewestFirstActiveBeforeEarlier() {
        let active = [chat("a1", ago: 5), chat("a2", ago: 1), chat("a3", ago: 3)]
        let older = [chat("o1", ago: 50), chat("o2", ago: 40)]
        let results = SmartSearch.results(SmartSearch.parse("claude"), active: active, older: older, now: now, calendar: calendar)
        XCTAssertEqual(results.active.map(\.key), ["a2", "a3", "a1"])
        XCTAssertEqual(results.older.map(\.key), ["o2", "o1"])
    }

    func testNothingTypedMatchesEverything() {
        XCTAssertTrue(SmartSearch.parse("  ").isEmpty)
        XCTAssertEqual(keys("", [chat("a")]), ["a"])
    }

    func testUnreadFiltersByWhatThePhoneHasNotOpened() {
        let list = [chat("a", "finished"), chat("b", "finished"), chat("c", "working")]
        let query = SmartSearch.parse("unread")
        let hit = SmartSearch.results(query, active: list, older: [], now: now, calendar: calendar, unread: { $0.key == "b" }).active.map(\.key)
        XCTAssertEqual(hit, ["b"])
        XCTAssertEqual(SmartSearch.parse("failed").tokens.first?.title, "Failed")
        XCTAssertEqual(SmartSearch.parse("done").tokens.first?.title, "Unread", "an old word reads as the new filter")
        XCTAssertEqual(SmartSearch.parse("needs you").tokens.first?.title, "Waiting")
    }

    func testChipsOrderCountAndLimit() {
        let sessions = (0..<7).map { chat("c\($0)", $0 == 0 ? "awaiting_input" : "working", repo: "p\($0)", ago: Double($0 + 1)) }
        let chips = SmartSearch.chips(sessions: sessions)
        XCTAssertEqual(chips.first?.kind, .needsYou(count: 1))
        XCTAssertEqual(chips.first?.title, "Waiting 1")
        XCTAssertEqual(chips.dropFirst().prefix(5).map(\.title), ["Unread", "Working", "Failed", "Claude", "Codex"])
        let projects = chips.dropFirst(6).map(\.title)
        XCTAssertEqual(projects, ["p0", "p1", "p2", "p3", "p4"], "five projects, newest chat first")
        XCTAssertFalse(SmartSearch.chips(sessions: sessions, chosen: [.state(.working)]).contains { $0.kind == .token(.state(.working)) })
    }
}
