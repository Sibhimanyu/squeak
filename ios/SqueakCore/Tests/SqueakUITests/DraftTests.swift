import XCTest
@testable import SqueakUI

final class DraftTests: XCTestCase {
    private func store() -> DraftStore {
        let defaults = UserDefaults(suiteName: "draft-tests-\(UUID().uuidString)")!
        return DraftStore(defaults: defaults)
    }

    func testRestoreIntoEmptyBoxGivesTheTextBack() {
        XCTAssertEqual(DraftPolicy.restoring("hello", into: ""), "hello")
        XCTAssertEqual(DraftPolicy.restoring("hello", into: " \n"), "hello")
    }

    func testRestoreKeepsWhatWasTypedSince() {
        XCTAssertEqual(DraftPolicy.restoring("first", into: "second"), "first\nsecond")
    }

    func testRestoreDoesNotDuplicate() {
        XCTAssertEqual(DraftPolicy.restoring("same", into: "same"), "same")
    }

    func testSendable() {
        XCTAssertFalse(DraftPolicy.isSendable("  \n"))
        XCTAssertTrue(DraftPolicy.isSendable("hi"))
        XCTAssertTrue(DraftPolicy.isSendable("", hasPhotos: true))
    }

    func testSavedDraftIsGoneOnceBlankSaved() {
        let s = store()
        s.save("half a thought", for: "a")
        XCTAssertEqual(s.draft(for: "a"), "half a thought")
        // A send clears the box and saves the empty box at once: nothing comes back on the next visit.
        s.save("", for: "a")
        XCTAssertEqual(s.draft(for: "a"), "")
    }

    func testDraftsAreKeptPerChat() {
        let s = store()
        s.save("one", for: "a"); s.save("two", for: "b")
        s.save("", for: "a")
        XCTAssertEqual(s.draft(for: "a"), "")
        XCTAssertEqual(s.draft(for: "b"), "two")
    }
}
