import Foundation
import XCTest
@testable import SqueakCore

/// RasanAI is an add-on: its screens show only while the Mac says it is on, and an older Mac (no `addons`) is
/// judged by whether it sent films.
final class RasanaiEnabledTests: XCTestCase {
    private func view(_ extra: String = "") throws -> PhoneSnapshot {
        let json = """
        {"v":1,"mac":"Mac","generatedAt":"2026-11-12T00:00:00Z","duck":{"blockedCount":0,"workingCount":0}\(extra),
         "sessions":[]}
        """
        return try JSONDecoder().decode(PhoneSnapshot.self, from: Data(json.utf8))
    }

    func testAddonListDecides() throws {
        XCTAssertTrue(try view(#","addons":["conductor","rasanai"]"#).rasanaiEnabled)
        XCTAssertFalse(try view(#","addons":["conductor"]"#).rasanaiEnabled)
        XCTAssertFalse(try view(#","addons":[]"#).rasanaiEnabled)
        // Even a stale films list is not shown once the add-on is off.
        XCTAssertFalse(try view(#","addons":[],"films":[]"#).rasanaiEnabled)
    }

    func testOlderMacIsJudgedByFilms() throws {
        XCTAssertFalse(try view().rasanaiEnabled)
        XCTAssertTrue(try view(#","films":[]"#).rasanaiEnabled)
    }

    func testNoFilmIsFoundWhileOff() throws {
        let on = try view(#","addons":["rasanai"],"films":[]"#)
        XCTAssertNil(on.film("film:0123456789abcdef"))
        XCTAssertTrue(on.rasanaiEnabled)
    }
}
