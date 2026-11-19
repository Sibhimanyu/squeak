import XCTest
@testable import SqueakMacCore

final class DirectoryLoadTests: XCTestCase {
    func testBackoffSequence() {
        let seq = (1...7).map { DirectoryLoad.delay(afterFailures: $0) }
        XCTAssertEqual(seq, [0.5, 1, 2, 4, 8, 8, 8])
    }

    func testNotLoadedIsNotEmpty() {
        var s = DirectoryLoad()
        XCTAssertTrue(s.isLoading)
        XCTAssertFalse(s.showsEmptyMessage(isEmpty: true))
        XCTAssertTrue(s.begin()); s.failed()
        XCTAssertTrue(s.needsRetry)
        XCTAssertEqual(s.nextDelay, 0.5)
        XCTAssertFalse(s.showsEmptyMessage(isEmpty: true))
    }

    func testSuccessfulEmptyShowsMessageAndStopsRetry() {
        var s = DirectoryLoad()
        _ = s.begin(); s.succeeded()
        XCTAssertFalse(s.needsRetry)
        XCTAssertTrue(s.showsEmptyMessage(isEmpty: true))
        XCTAssertFalse(s.showsEmptyMessage(isEmpty: false))
    }

    func testNoStackingAndFailureAfterLoadKeepsLoaded() {
        var s = DirectoryLoad()
        XCTAssertTrue(s.begin())
        XCTAssertFalse(s.begin())
        s.succeeded()
        XCTAssertTrue(s.begin()); s.failed()
        XCTAssertTrue(s.loaded)
        XCTAssertEqual(s.failures, 0)
    }

    func test404StopsRetryAndAllowsEmptyMessage() {
        var s = DirectoryLoad()
        _ = s.begin(); s.unsupportedHost()
        XCTAssertFalse(s.needsRetry)
        XCTAssertTrue(s.showsEmptyMessage(isEmpty: true))
    }
}
