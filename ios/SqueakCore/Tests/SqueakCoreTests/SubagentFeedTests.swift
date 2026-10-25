import Foundation
import XCTest
@testable import SqueakCore

/// The subagent feed's shapes, from docs/remote-channel.md "Subagent feed" (src/remote/subagent-feed.ts).
final class SubagentFeedTests: XCTestCase {
    func testDocIsTheLiveHandlePlusS() {
        XCTAssertEqual(SubagentFeed.doc(for: "claude-transcript:5f0c/abc"), "3L87aiI9mm-5nwW-Vr6HYr-s")
    }

    func testDecodesTheMacsDocument() throws {
        let json = #"{"v":1,"key":"s1","taskId":"toolu_01abcdef","agentId":"a1b2c3d4e5f607182","label":"Survey the tests","status":"running","available":true,"total":4,"steps":[{"kind":"thinking","text":"Hmm","at":null},{"kind":"tool","text":"Read a.ts","at":"2026-10-25T07:00:00Z"}],"seq":123}"#
        let feed = try JSONDecoder().decode(SubagentFeed.self, from: Data(json.utf8))
        XCTAssertEqual(feed.taskId, "toolu_01abcdef")
        XCTAssertEqual(feed.agentId, "a1b2c3d4e5f607182")
        XCTAssertEqual(feed.steps.map(\.kind), ["thinking", "tool"])
        XCTAssertEqual(feed.seq, 123)
        let unreadable = #"{"v":1,"key":"s1","taskId":"toolu_01abcdef","agentId":null,"label":"x","status":"done","available":false,"total":0,"steps":[]}"#
        let none = try JSONDecoder().decode(SubagentFeed.self, from: Data(unreadable.utf8))
        XCTAssertNil(none.agentId); XCTAssertFalse(none.available); XCTAssertNil(none.seq)
    }

    func testBackgroundTaskFieldsAreOptional() throws {
        let old = #"{"id":"t","kind":"agent","label":"L","status":"running","background":true}"#
        let task = try JSONDecoder().decode(PhoneSnapshot.Session.BackgroundTask.self, from: Data(old.utf8))
        XCTAssertNil(task.agentId); XCTAssertFalse(task.canOpenSteps)
        let new = #"{"id":"toolu_01abcdef","kind":"agent","label":"L","status":"running","background":true,"agentId":"a1b2c3d4e5f607182","hasSteps":true}"#
        XCTAssertTrue(try JSONDecoder().decode(PhoneSnapshot.Session.BackgroundTask.self, from: Data(new.utf8)).canOpenSteps)
        let shell = PhoneSnapshot.Session.BackgroundTask(id: "s", kind: "shell", label: "x", status: "running", hasSteps: true)
        XCTAssertFalse(shell.canOpenSteps)
    }

    func testCommandHasExactlyTheDocumentedKeysAndNullStops() throws {
        func keys(_ taskId: String?) throws -> [String: Any] {
            let data = try JSONEncoder().encode(SubagentCommand(key: "k", taskId: taskId, nonce: "ab", expiresAt: 5))
            return try JSONSerialization.jsonObject(with: data) as! [String: Any]
        }
        let pick = try keys("toolu_01abcdef")
        XCTAssertEqual(Set(pick.keys), ["v", "kind", "key", "taskId", "nonce", "expiresAt"])
        XCTAssertEqual(pick["kind"] as? String, "subagent")
        let stop = try keys(nil)
        XCTAssertEqual(Set(stop.keys), ["v", "kind", "key", "taskId", "nonce", "expiresAt"])
        XCTAssertTrue(stop["taskId"] is NSNull)
    }

    func testSealedFeedRoundTrips() throws {
        let key = Data(repeating: 7, count: 32).base64EncodedString()
        let feed = SubagentFeed(key: "s1", taskId: "toolu_01abcdef", label: "L", status: "running", available: true, total: 1,
                                steps: [.init(kind: "note", text: "hi")], seq: 9)
        let box = try ChannelCrypto.seal(feed, key: key)
        XCTAssertEqual(try ChannelCrypto.open(SubagentFeed.self, box: box, key: key), feed)
    }
}
