import Foundation
import XCTest
@testable import SqueakMacCore

final class PondPanelTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func fact(_ id: String, _ state: SessionState, ago: TimeInterval?, start: TimeInterval? = nil, title: String? = nil) -> PondThreadFact {
        PondThreadFact(key: SessionKey(provider: "squeak", hostSessionId: id), title: title ?? id, state: state,
                       lastActivityAt: ago.map { now.addingTimeInterval(-$0) }, startedAt: start.map { now.addingTimeInterval(-$0) })
    }

    func testChangedSentence() {
        XCTAssertEqual(PondSentence.changed(files: 4, added: 120, removed: 30), "Changed 4 files, +120 \u{2212}30")
        XCTAssertEqual(PondSentence.changed(files: 1, added: 2, removed: 0), "Changed 1 file, +2 \u{2212}0")
        XCTAssertNil(PondSentence.changed(files: 0, added: 0, removed: 0))
    }

    func testPresenceIsOnlyYouAndTheAgent() {
        let m = PondPresence.members(person: "Sibhi Mani", agent: "claude", agentName: "Claude", model: "Opus 5.5")
        XCTAssertEqual(m.map(\.kind), [.person, .agent])
        XCTAssertEqual(m[0].initial, "S")
        XCTAssertEqual(m[1].detail, "Opus 5.5")
        XCTAssertEqual(PondPresence.members(person: " ", agent: nil, agentName: nil, model: nil).map(\.name), ["You"])
        XCTAssertEqual(m[0].colourIndex, PondPresence.colourIndex(for: "Sibhi Mani"))
        XCTAssertTrue((0..<PondPresence.avatarColours).contains(m[0].colourIndex))
    }

    func testTiming() {
        XCTAssertEqual(PondSentence.timing(state: .working, startedAt: now.addingTimeInterval(-720), lastActivityAt: nil, now: now), "Working for 12 min")
        XCTAssertEqual(PondSentence.timing(state: .working, startedAt: nil, lastActivityAt: nil, now: now), "Working now")
        XCTAssertEqual(PondSentence.timing(state: .finished, startedAt: nil, lastActivityAt: now.addingTimeInterval(-7500), now: now), "Finished 2 h 5 min ago")
        XCTAssertEqual(PondSentence.timing(state: .error, startedAt: nil, lastActivityAt: now.addingTimeInterval(-30), now: now), "Failed 1 min ago")
        XCTAssertNil(PondSentence.timing(state: .unknown, startedAt: nil, lastActivityAt: nil, now: now))
    }

    func testRipplesNewestFirstAndCapped() {
        let threads = [fact("a", .finished, ago: 600, start: 4000, title: "Fix login"), fact("b", .error, ago: 60, title: "Build"), fact("c", .working, ago: 5)]
        let prs = [PondPullRequestFact(number: 7, merged: false, at: now.addingTimeInterval(-300), threadTitle: "Fix login")]
        let r = PondRipples.build(threads: threads, pullRequests: prs, changed: ("Fix login", 4, now.addingTimeInterval(-900)))
        XCTAssertEqual(r.map(\.sentence), ["Build failed", "PR #7 opened from Fix login", "Fix login finished", "Fix login changed 4 files", "Fix login started"])
        XCTAssertEqual(PondRipples.build(threads: threads, cap: 2).count, 2)
        let many = (0..<40).map { fact("t\($0)", .finished, ago: Double($0 + 1)) }
        XCTAssertEqual(PondRipples.build(threads: many).count, 20)
    }

    func testRipplesSkipUntimedFacts() {
        XCTAssertTrue(PondRipples.build(threads: [fact("a", .finished, ago: nil)], pullRequests: [PondPullRequestFact(number: 1, merged: true, at: nil, threadTitle: "x")]).isEmpty)
    }

    func testOrdering() {
        let t = [fact("a", .idle, ago: 100, title: "Beta"), fact("b", .blocked, ago: 10), fact("c", .idle, ago: 100, title: "Alpha"), fact("d", .blocked, ago: 5)]
        XCTAssertEqual(PondOrdering.others(t, excluding: t[1].key).map(\.title), ["d", "Alpha", "Beta"])
        XCTAssertEqual(PondOrdering.needsYou(t).map(\.title), ["d", "b"])
    }
}
