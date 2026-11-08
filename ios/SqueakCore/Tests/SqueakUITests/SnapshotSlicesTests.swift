import SqueakCore
import XCTest
@testable import SqueakUI

/// Publishing only what changed, and Home's memoized lists.
final class SnapshotSlicesTests: XCTestCase {
    private func chat(_ key: String, _ state: String = "finished", repo: String = "storefront", at: String = "2026-10-19T10:00:00Z",
                      message: String? = "done") -> PhoneSnapshot.Session {
        .init(key: key, conductorSessionId: key, label: "\(repo) · \(key)", agent: "claude", state: state, lastActivityAt: at,
              detail: nil, git: nil, contextPercent: nil, turnId: "t", message: message, choices: nil, title: key)
    }

    private func view(_ sessions: [PhoneSnapshot.Session], recent: [PhoneSnapshot.Session]? = nil) -> PhoneSnapshot {
        PhoneSnapshot(v: 1, mac: "Mac", generatedAt: "2026-10-19T10:00:00Z", duck: .init(blockedCount: 0, workingCount: 0),
                      sessions: sessions, recent: recent)
    }

    func testUnchangedViewPublishesNothing() {
        let v = view([chat("a"), chat("b")])
        let first = SnapshotPlan.make(view: v, previousView: nil, previous: nil)
        let again = SnapshotPlan.make(view: v, previousView: v, previous: first.slices)
        XCTAssertFalse(again.changedAnything)
    }

    func testOnlyTheChangedChatIsPublished() {
        let before = view([chat("a"), chat("b")])
        let first = SnapshotPlan.make(view: before, previousView: nil, previous: nil)
        let after = view([chat("a"), chat("b", "working")])
        let plan = SnapshotPlan.make(view: after, previousView: before, previous: first.slices)
        XCTAssertEqual(Set(plan.changedSessions.keys), ["b"])
        XCTAssertTrue(plan.removedSessions.isEmpty)
        XCTAssertTrue(plan.homeChanged)
        XCTAssertFalse(plan.controlsChanged)
    }

    func testRemovedChatIsReportedAndActiveWinsOverRecent() {
        let before = view([chat("a")], recent: [chat("b")])
        let first = SnapshotPlan.make(view: before, previousView: nil, previous: nil)
        let after = view([chat("b", "working")], recent: [chat("b")])
        let plan = SnapshotPlan.make(view: after, previousView: before, previous: first.slices)
        XCTAssertEqual(plan.removedSessions, ["a"])
        XCTAssertEqual(plan.slices.sessions["b"]?.state, "working")
        XCTAssertEqual(plan.slices.home.recent.count, 0)
    }

    func testHomeListsEqualPresentationGrouping() {
        let sessions = [chat("a", repo: "one", at: "2026-10-19T10:00:00Z"), chat("b", repo: "two", at: "2026-10-19T12:00:00Z"),
                        chat("c", "working", repo: "one", at: "2026-10-19T11:00:00Z")]
        let home = HomeSlice(view(sessions))
        let lists = HomeLists.make(home: home, hidden: [:], seen: [:])
        XCTAssertEqual(lists.projects, Presentation.projects(sessions))
        XCTAssertEqual(lists.visible, sessions)
        XCTAssertTrue(lists.unread.isEmpty)
    }

    func testHiddenAndUnreadRules() {
        let a = chat("a"), old = chat("old", repo: "elsewhere", at: "2026-10-18T10:00:00Z")
        let home = HomeSlice(view([a], recent: [old]))
        let hidden = ["a": 4_000_000_000.0]
        let seen = ["old": 0.0]
        let lists = HomeLists.make(home: home, hidden: hidden, seen: seen)
        XCTAssertTrue(lists.visible.isEmpty)
        XCTAssertEqual(lists.unread.map(\.key), ["old"])
        XCTAssertEqual(lists.projects.map(\.name), ["elsewhere"])
    }

    func testProjectWithOnlyQuietChatsIsListed() {
        let home = HomeSlice(view([chat("a", "working", repo: "one")], recent: [chat("q", repo: "quiet", at: "2026-10-18T10:00:00Z")]))
        let lists = HomeLists.make(home: home, hidden: [:], seen: [:])
        XCTAssertEqual(Set(lists.projects.map(\.name)), ["one", "quiet"])
        XCTAssertEqual(lists.visible.map(\.key), ["a"])
    }

    func testProjectsAreNewestFirstAcrossActiveAndQuiet() {
        let home = HomeSlice(view([chat("a", repo: "old-active", at: "2026-10-19T08:00:00Z")],
                                  recent: [chat("q", repo: "newer-quiet", at: "2026-10-19T09:00:00Z"),
                                           chat("r", repo: "oldest", at: "2026-10-01T09:00:00Z")]))
        let lists = HomeLists.make(home: home, hidden: [:], seen: [:])
        XCTAssertEqual(lists.projects.map(\.name), ["newer-quiet", "old-active", "oldest"])
    }

    func testHiddenQuietChatsAreExcluded() {
        let home = HomeSlice(view([], recent: [chat("q", repo: "quiet", at: "2026-10-18T10:00:00Z"), chat("k", repo: "kept", at: "2026-10-17T10:00:00Z")]))
        let lists = HomeLists.make(home: home, hidden: ["q": 4_000_000_000.0], seen: [:])
        XCTAssertEqual(lists.projects.map(\.name), ["kept"])
    }

    func testStableIndexedKeepsIdsAsItemsAreAppended() {
        let small = StableIndexed.make(["x", "y"], first: 5)
        let grown = StableIndexed.make(["x", "y", "z"], first: 5)
        XCTAssertEqual(small.map(\.id), [5, 6])
        XCTAssertEqual(Array(grown.map(\.id).prefix(2)), small.map(\.id))
    }
}
