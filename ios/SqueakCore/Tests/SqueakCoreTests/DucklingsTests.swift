import Foundation
import XCTest
@testable import SqueakCore

/// Background ducklings (.context/ducklings/CONTRACT.md): optional on the session, absent from an older Mac.
final class DucklingsTests: XCTestCase {
    private func session(_ extra: String, state: String = "idle") throws -> PhoneSnapshot.Session {
        let json = """
        {"v":1,"mac":"Mac","generatedAt":"2026-11-12T00:00:00Z","duck":{"blockedCount":0,"workingCount":0},
         "sessions":[{"key":"k","label":"a · b","agent":"claude","state":"\(state)","lastActivityAt":"2026-11-12T00:00:00Z"\(extra)}]}
        """
        return try JSONDecoder().decode(PhoneSnapshot.self, from: Data(json.utf8)).sessions[0]
    }

    func testAbsentFieldChangesNothing() throws {
        let s = try session("")
        XCTAssertNil(s.ducklings)
        XCTAssertTrue(s.helpers.isEmpty)
        XCTAssertFalse(s.readyWithDucklings)
    }

    func testIdleChatWithRunningHelpersIsReady() throws {
        let s = try session(#","ducklings":{"running":1,"items":[{"id":"a","kind":"agent","title":"Find callers","model":"Sonnet 5.5","status":"running","startedAt":"2026-11-12T00:00:00Z"},{"id":"b","kind":"shell","title":"npm test","status":"failed","startedAt":"2026-11-12T00:00:00Z","endedAt":"2026-11-12T00:01:00Z","summary":"exit 1"}]}"#)
        XCTAssertEqual(s.ducklingsRunning, 1)
        XCTAssertTrue(s.readyWithDucklings)
        XCTAssertEqual(s.helpers.map(\.label), ["Find callers", "npm test"])
        XCTAssertEqual(s.helpers[0].model, "Sonnet 5.5")
        XCTAssertTrue(s.helpers[0].canOpenDetail)
        XCTAssertFalse(s.helpers[1].canOpenDetail)
    }

    func testWorkingChatIsNotReady() throws {
        let s = try session(#","ducklings":{"running":2,"items":[]}"#, state: "working")
        XCTAssertFalse(s.readyWithDucklings)
    }

    func testPhoneAdvertisesDucklings() {
        XCTAssertTrue(ChannelCrypto.capabilities.contains("ducklings"))
    }
}
