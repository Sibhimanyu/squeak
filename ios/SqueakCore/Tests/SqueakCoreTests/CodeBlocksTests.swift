import XCTest
@testable import SqueakCore

final class CodeBlocksTests: XCTestCase {
    func testBlocksAreWholeInOrderWithoutFences() {
        let text = "Paste this:\n```yaml\nchannel: a\n\nkey: b\n```\nthen\n~~~\nls -la\n~~~\n"
        XCTAssertEqual(MessageCodeBlocks.blocks(in: text), ["channel: a\n\nkey: b", "ls -la"])
    }

    func testUnclosedAndEmptyBlocksAreSkipped() {
        XCTAssertEqual(MessageCodeBlocks.blocks(in: "```\n```\nplain\n```\nnever closed"), [])
    }
}
