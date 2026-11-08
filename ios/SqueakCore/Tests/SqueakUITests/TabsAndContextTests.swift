import SqueakCore
import XCTest
@testable import SqueakUI

final class TabsAndContextTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func session(_ key: String, state: String, agoMinutes: Double) -> PhoneSnapshot.Session {
        let at = ISO8601DateFormatter().string(from: now.addingTimeInterval(-agoMinutes * 60))
        return .init(key: key, conductorSessionId: key, label: "repo · \(key)", agent: "claude", state: state, lastActivityAt: at,
                     detail: nil, git: nil, contextPercent: nil, turnId: "t", message: nil, choices: nil, activity: nil, title: key)
    }

    func testFirstLaunchOpensNeedsYouThenTheLastTab() {
        XCTAssertEqual(AppTab.initial(stored: nil, arguments: []), .needsYou)
        XCTAssertEqual(AppTab.initial(stored: "", arguments: []), .needsYou)
        XCTAssertEqual(AppTab.initial(stored: "sessions", arguments: []), .sessions)
        XCTAssertEqual(AppTab.initial(stored: "settings", arguments: []), .settings)
        XCTAssertEqual(AppTab.initial(stored: "home", arguments: []), .needsYou, "a tab that no longer exists falls back")
    }

    func testLaunchFlagsWinAndHomeMapsToSessions() {
        XCTAssertEqual(AppTab.initial(stored: "sessions", arguments: ["-squeak-tab-needs"]), .needsYou)
        XCTAssertEqual(AppTab.initial(stored: nil, arguments: ["-squeak-tab-home"]), .sessions)
        XCTAssertEqual(AppTab.initial(stored: nil, arguments: ["-squeak-settings"]), .settings)
    }

    func testDecisionsLeaveOnlyRunningBelow() {
        let all = [session("a", state: "working", agoMinutes: 5), session("b", state: "finished", agoMinutes: 30)]
        let context = NeedsYou.context(sessions: all, decisions: 1, now: now)
        XCTAssertEqual(context.running.map(\.key), ["a"])
        XCTAssertTrue(context.recent.isEmpty)
    }

    func testNothingBlockedShowsRecentChangesNewestFirstWithinADayAndCapped() {
        var all = (0..<6).map { session("f\($0)", state: "finished", agoMinutes: Double($0 + 1) * 10) }
        all.append(session("old", state: "finished", agoMinutes: 25 * 60))
        all.append(session("run", state: "working", agoMinutes: 1))
        let context = NeedsYou.context(sessions: all, decisions: 0, now: now)
        XCTAssertEqual(context.recent.map(\.key), ["f0", "f1", "f2", "f3"])
        XCTAssertEqual(context.running.map(\.key), ["run"])
    }

    func testTheSessionsSwitchSaysList() {
        XCTAssertEqual(Presentation.Grouping.status.tabTitle, "List")
        XCTAssertEqual(Presentation.Grouping.projects.tabTitle, "Projects")
    }
}
