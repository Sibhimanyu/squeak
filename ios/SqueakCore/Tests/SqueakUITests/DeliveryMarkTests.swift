import XCTest
@testable import SqueakUI

final class DeliveryMarkTests: XCTestCase {
    func testPlainStatesAreGlyphsWithWordsForVoiceOver() {
        XCTAssertEqual(ChatSend.Status.sending.mark, .sending)
        XCTAssertEqual(ChatSend.Status.sent.mark, .sent)
        XCTAssertEqual(ChatSend.Status.read(agent: "Claude").mark, .read)
        for status: ChatSend.Status in [.sending, .sent, .read(agent: "Claude")] {
            XCTAssertNil(status.visibleLine)
            XCTAssertFalse(status.line.isEmpty)
        }
        XCTAssertEqual(ChatSend.Status.read(agent: "Claude").line, "Read by Claude")
    }

    func testQueuedIsShortAndDimmedUntilRead() {
        let queued = ChatSend.Status.queued(agent: "Claude", steerUnavailable: false)
        XCTAssertNil(queued.mark)
        XCTAssertEqual(queued.visibleLine, "Queued")
        XCTAssertTrue(queued.waitingToBeRead)
        XCTAssertFalse(ChatSend.Status.read(agent: "Claude").waitingToBeRead)
    }

    func testProblemsKeepTheirSentence() {
        let refused = ChatSend.Status.refused("the chat is busy")
        XCTAssertNil(refused.mark)
        XCTAssertEqual(refused.visibleLine, "Not sent. Nothing started. The chat is busy.")
        XCTAssertEqual(ChatSend.Status.notConfirmed.visibleLine, ChatSend.Status.notConfirmed.line)
    }
}
