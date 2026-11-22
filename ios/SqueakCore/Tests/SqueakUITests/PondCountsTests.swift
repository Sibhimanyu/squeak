import Foundation
import SqueakCore
import XCTest
@testable import SqueakUI

final class PondCountsTests: XCTestCase {
    private func chat(_ key: String, _ state: String = "idle", duck: String? = nil, off: Bool = false, hour: Int = 10) -> PhoneSnapshot.Session {
        var s = PhoneSnapshot.Session(
            key: key, conductorSessionId: nil, label: key, agent: "claude", state: state,
            lastActivityAt: String(format: "2026-11-09T%02d:00:00Z", hour), detail: nil, git: nil, contextPercent: nil,
            turnId: nil, message: nil, choices: nil, title: key)
        s.duckId = duck
        if off { s.duckDuty = "off" }
        return s
    }

    func testFallbackCountsLikeTheDaemon() {
        let c = PondCounts.fallback(sessions: [
            chat("a", "working"), chat("b", "awaiting_approval"), chat("c"), chat("d", off: true), chat("e", "working", off: true),
        ])
        XCTAssertEqual(c, PondCounts(onDuty: 3, working: 1, needsYou: 1, offDuty: 2, total: 5))
    }

    func testOneDuckIsCountedOnceByItsNewestChat() {
        let c = PondCounts.fallback(sessions: [chat("old", "working", duck: "d1", hour: 8), chat("new", "idle", duck: "d1", hour: 9)])
        XCTAssertEqual(c, PondCounts(onDuty: 1, working: 0, needsYou: 0, offDuty: 0, total: 1))
    }

    func testSentCountsWinAndTilesReadThem() {
        let sent = PondCounts(onDuty: 4, working: 2, needsYou: 1, offDuty: 3, total: 7)
        XCTAssertEqual(PondCounts.resolve(sent, sessions: [chat("a")]), sent)
        XCTAssertEqual(PondTileModel.count(.onDuty, sent), 4)
        XCTAssertEqual(PondTileModel.count(.offDuty, sent), 3)
        XCTAssertEqual(PondTileModel.secondary(.offDuty, sent), "7 in all")
        XCTAssertNil(PondTileModel.secondary(.working, sent))
        XCTAssertEqual(PondScope.tiles, [.onDuty, .working, .needsYou, .offDuty])
    }

    func testScopeListsFilterByDuty() {
        let sessions = [chat("a", "working"), chat("d", off: true)]
        let item = PondItem(id: "p", name: "p", pond: nil, sessions: sessions, meta: PondMeta())
        XCTAssertEqual(PondList.sessions(item, scope: .onDuty).map(\.key), ["a"])
        XCTAssertEqual(PondList.sessions(item, scope: .offDuty).map(\.key), ["d"])
        XCTAssertEqual(PondList.sessions(item, scope: .working).map(\.key), ["a"])
    }

    func testPondDecodesCountsAndAnOlderMacWithoutThem() throws {
        let json = #"{"id":"a","name":"A","shared":false,"members":[],"counts":{"onDuty":2,"working":1,"needsYou":0,"offDuty":1,"total":3}}"#
        let p = try JSONDecoder().decode(PhoneSnapshot.Pond.self, from: Data(json.utf8))
        XCTAssertEqual(p.counts, PondCounts(onDuty: 2, working: 1, needsYou: 0, offDuty: 1, total: 3))
        let old = try JSONDecoder().decode(PhoneSnapshot.Pond.self, from: Data(#"{"id":"a","name":"A","shared":false,"members":[]}"#.utf8))
        XCTAssertNil(old.counts)
    }
}
