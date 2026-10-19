import Foundation
import XCTest
@testable import SqueakCore

final class LiveTurnTests: XCTestCase {
    func testHandleMatchesTheMac() {
        // node: createHash("sha256").update(key).digest("base64url").slice(0, 22)
        XCTAssertEqual(LiveTurn.handle(for: "claude-transcript:5f0c/abc"), "3L87aiI9mm-5nwW-Vr6HYr")
    }

    func testDecodesTheMacsShape() throws {
        let json = #"{"v":1,"key":"s1","working":true,"total":2,"steps":[{"kind":"thinking","text":"Hmm","at":null},{"kind":"tool","text":"Run npm test","at":"2026-10-19T07:00:00Z"}]}"#
        let turn = try JSONDecoder().decode(LiveTurn.self, from: Data(json.utf8))
        XCTAssertEqual(turn.steps.map(\.kind), ["thinking", "tool"])
        XCTAssertNil(turn.steps[0].at)
    }

    func testPresenceAsksForMoreRecentOnlyWhenTold() throws {
        let asked = String(data: try JSONEncoder().encode(Presence(at: 5, recent: 30)), encoding: .utf8)!
        XCTAssertTrue(asked.contains(#""recent":30"#))
        let plain = String(data: try JSONEncoder().encode(Presence(at: 5)), encoding: .utf8)!
        XCTAssertFalse(plain.contains("recent"))
    }

    func testPresenceLeavesWatchingOutWhenNotVerbose() throws {
        let plain = String(data: try JSONEncoder().encode(Presence(at: 5)), encoding: .utf8)
        XCTAssertEqual(plain, #"{"at":5}"#)
    }
}
