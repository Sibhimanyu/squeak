import SqueakCore
import XCTest

final class DiffResultTests: XCTestCase {
    /// The Mac's answer to a diff request (remote-bridge.ts handleDiff), decoded as the phone reads it.
    func testDecodesTheMacsDiffAnswer() throws {
        let json = #"""
        {"id":"c1","status":"sent","diff":{"baseRef":"origin/main","files":[{"path":"src/a.ts","insertions":3,"deletions":1,"binary":false,"untracked":false}],"insertions":3,"deletions":1,"truncated":false},"patch":{"index":0,"path":"src/a.ts","text":"@@ -1 +1 @@\n-a\n+b"}}
        """#
        let result = try JSONDecoder().decode(CommandResult.self, from: Data(json.utf8))
        XCTAssertTrue(result.sent)
        XCTAssertEqual(result.diff?.files.first?.path, "src/a.ts")
        XCTAssertEqual(result.diff?.insertions, 3)
        XCTAssertEqual(result.patch?.text, "@@ -1 +1 @@\n-a\n+b")
    }

    func testAnswersWithoutADiffStillDecode() throws {
        let result = try JSONDecoder().decode(CommandResult.self, from: Data(#"{"status":"refused","reason":"no"}"#.utf8))
        XCTAssertNil(result.diff)
        XCTAssertNil(result.patch)
    }
}

final class UnconfirmedResultTests: XCTestCase {
    func testUnconfirmedIsNotSent() throws {
        let result = try JSONDecoder().decode(CommandResult.self, from: Data(#"{"status":"unconfirmed","reason":"Check the chat."}"#.utf8))
        XCTAssertTrue(result.unconfirmed)
        XCTAssertFalse(result.sent)
        XCTAssertEqual(result.reason, "Check the chat.")
    }
}
