import XCTest
@testable import SqueakMacCore

final class MovedChatTests: XCTestCase {
    func testReplyDecodesMovedTo() {
        let moved = NativeSendReply.decode(Data(#"{"queued":false,"movedTo":"abc"}"#.utf8))
        XCTAssertEqual(moved, NativeSendReply(queued: false, movedTo: "abc"))
        XCTAssertEqual(NativeSendReply.decode(Data(#"{"queued":true}"#.utf8)), NativeSendReply(queued: true, movedTo: nil))
        XCTAssertNil(NativeSendReply.decode(Data(#"{"queued":false,"movedTo":""}"#.utf8)).movedTo)
        XCTAssertEqual(NativeSendReply.decode(Data("nope".utf8)), NativeSendReply(queued: false))
    }

    func testMovedChatIsTakenOnce() {
        let moved = MovedChats()
        moved.record(from: "old", to: "new")
        XCTAssertNil(moved.take(from: "other"))
        XCTAssertEqual(moved.take(from: "old"), "new")
        XCTAssertNil(moved.take(from: "old"))
    }
}
