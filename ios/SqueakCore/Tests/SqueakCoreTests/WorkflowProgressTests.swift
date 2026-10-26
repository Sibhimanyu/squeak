import Foundation
import XCTest
@testable import SqueakCore

final class WorkflowProgressTests: XCTestCase {
    private func session(_ extra: String) throws -> PhoneSnapshot.Session {
        let json = """
        {"key":"k","conductorSessionId":null,"label":"l","agent":"claude","state":"working",
         "lastActivityAt":"2026-10-26T07:19:52.480Z","detail":null,"git":null,"contextPercent":null,
         "turnId":null,"message":null,"choices":null\(extra)}
        """
        return try JSONDecoder().decode(PhoneSnapshot.Session.self, from: Data(json.utf8))
    }

    func testDecodesAFilmsProgress() throws {
        let extra = #","workflowProgress":{"provider":"rasanai","title":"26keys","step":"brief","call":"brief","calls":[{"call":"brief","state":"now"},{"call":"story","state":"next"},{"call":"look","state":"next"},{"call":"animatic","state":"next"},{"call":"final","state":"next"}],"waiting":false,"activity":"Checking the tools","activityAt":"2026-10-26T07:19:52.480Z"}"#
        let p = try XCTUnwrap(try session(extra).workflowProgress)
        XCTAssertEqual(p.title, "26keys")
        XCTAssertEqual(p.calls.map(\.call), ["brief", "story", "look", "animatic", "final"])
        XCTAssertEqual(p.calls.first?.state, "now")
        XCTAssertFalse(p.waiting)
        XCTAssertEqual(p.activity, "Checking the tools")
    }

    func testUnknownCallAndStateStringsDoNotFailTheSession() throws {
        let extra = #","workflowProgress":{"provider":"rasanai","title":null,"call":"premiere","calls":[{"call":"premiere","state":"paused"}],"waiting":true,"activity":null,"activityAt":null}"#
        let p = try XCTUnwrap(try session(extra).workflowProgress)
        XCTAssertEqual(p.call, "premiere")
        XCTAssertEqual(p.calls.first?.state, "paused")
        XCTAssertNil(p.title)
        XCTAssertTrue(p.waiting)
    }

    func testAnOldPayloadHasNoProgress() throws {
        XCTAssertNil(try session("").workflowProgress)
    }
}
