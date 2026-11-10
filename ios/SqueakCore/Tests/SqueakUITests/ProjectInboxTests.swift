import Foundation
import SqueakCore
import XCTest
@testable import SqueakUI

final class ProjectInboxTests: XCTestCase {
    private func chat(_ key: String, _ state: String, repo: String, hour: Int) -> PhoneSnapshot.Session {
        .init(key: key, conductorSessionId: nil, label: "\(repo) · main", agent: "claude", state: state,
              lastActivityAt: String(format: "2026-11-09T%02d:00:00Z", hour), detail: "Latest reply",
              git: nil, contextPercent: nil, turnId: nil, message: "Done", choices: nil)
    }

    func testWorkingAndUnopenedRepliesLeadReadProjectsByRecency() {
        let projects = Presentation.projects([
            chat("quiet", "idle", repo: "quiet", hour: 15),
            chat("read", "finished", repo: "read", hour: 14),
            chat("run", "working", repo: "running", hour: 12),
            chat("done", "finished", repo: "unopened", hour: 13),
        ])
        XCTAssertEqual(ProjectInbox.ordered(projects, seen: ["read": .greatestFiniteMagnitude]).map(\.name),
                       ["unopened", "running", "quiet", "read"])
    }

    func testNewReplyBumpsImmediatelyAndOpeningChatClearsPriority() throws {
        let busy = chat("run", "working", repo: "running", hour: 12)
        let first = chat("done", "finished", repo: "reply", hour: 11)
        let projects = Presentation.projects([busy, first])
        XCTAssertEqual(ProjectInbox.ordered(projects, seen: [:]).first?.name, "running")
        let reply = chat("done", "finished", repo: "reply", hour: 13)
        let updated = Presentation.projects([busy, reply])
        XCTAssertEqual(ProjectInbox.ordered(updated, seen: [:]).first?.name, "reply")
        XCTAssertTrue(ProjectInbox.isUnread(reply, seen: [:]))
        let opened = try XCTUnwrap(Age.date(reply.lastActivityAt)).timeIntervalSince1970 + 5
        let seen = [reply.key: opened]
        XCTAssertFalse(ProjectInbox.isUnread(reply, seen: seen))
        XCTAssertEqual(ProjectInbox.ordered(updated, seen: seen).first?.name, "running")
        let later = chat("done", "finished", repo: "reply", hour: 14)
        XCTAssertTrue(ProjectInbox.isUnread(later, seen: seen))
        XCTAssertEqual(ProjectInbox.ordered(Presentation.projects([busy, later]), seen: seen).first?.name, "reply")
    }

    func testOlderRunningChatStillRaisesProjectAndLocalStartCounts() {
        let projects = Presentation.projects([
            chat("old", "working", repo: "mixed", hour: 8),
            chat("new", "idle", repo: "mixed", hour: 11),
            chat("quiet", "idle", repo: "quiet", hour: 15),
        ])
        XCTAssertEqual(ProjectInbox.ordered(projects, seen: [:]).first?.name, "mixed")
        XCTAssertEqual(ProjectInbox.ordered(projects, seen: [:], starting: ["quiet"]).first?.name, "quiet")
    }

    func testNonFinishedStatesDoNotBecomeUnreadAndTiesAreDeterministic() {
        let a = chat("a", "idle", repo: "alpha", hour: 12)
        let z = chat("z", "working", repo: "zeta", hour: 12)
        XCTAssertFalse(ProjectInbox.isUnread(a, seen: [:]))
        XCTAssertFalse(ProjectInbox.isUnread(z, seen: [:]))
        let projects = Presentation.projects([z, chat("b", "working", repo: "beta", hour: 12)])
        XCTAssertEqual(ProjectInbox.ordered(projects, seen: [:]).map(\.name), ["beta", "zeta"])
    }
}
