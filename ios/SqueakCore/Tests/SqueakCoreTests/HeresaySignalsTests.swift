import Foundation
import XCTest
@testable import SqueakCore

final class HeresaySignalsTests: XCTestCase {
    func testIdPrefersUserIdThenHashesEmail() {
        XCTAssertEqual(HeresayIdentity.id(userId: " u123 ", email: "a@b.c"), "u123")
        let a = HeresayIdentity.id(userId: nil, email: "Sam@Example.com ")
        XCTAssertEqual(a, HeresayIdentity.id(userId: "", email: "sam@example.com"))
        XCTAssertTrue(a?.hasPrefix("acct_") == true)
        XCTAssertFalse(a?.contains("sam") == true)
        XCTAssertNil(HeresayIdentity.id(userId: nil, email: nil))
        XCTAssertNil(HeresayIdentity.id(userId: nil, email: "  "))
    }

    func testNudgeFiresOncePerEpisode() {
        var g = NudgeGate(after: 30)
        let t = Date(timeIntervalSince1970: 1000)
        func look(_ down: TimeInterval?, at s: TimeInterval) -> Bool {
            g.observe(downSince: down.map { t.addingTimeInterval($0) }, now: t.addingTimeInterval(s))
        }
        XCTAssertFalse(look(0, at: 20))
        XCTAssertTrue(look(0, at: 31))
        XCTAssertFalse(look(0, at: 90))
        XCTAssertFalse(look(nil, at: 95))
        XCTAssertFalse(look(100, at: 110))
        XCTAssertTrue(look(100, at: 140))
    }
}
