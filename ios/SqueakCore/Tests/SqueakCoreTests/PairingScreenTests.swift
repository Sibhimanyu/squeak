import XCTest
@testable import SqueakCore

final class PairingScreenTests: XCTestCase {
    private func resolve(awaiting: Bool = false, approved: String? = nil, failure: PairingFailure? = nil, waited: TimeInterval = 0) -> PairingScreen {
        PairingScreen.resolve(awaiting: awaiting ? ("Studio Mac", "123456") : nil, approvedMac: approved, failure: failure, waited: waited)
    }

    func testNothingStartedIsReadyWithOneJob() {
        let s = resolve()
        XCTAssertEqual(s, .ready)
        XCTAssertEqual(s.title, "Scan the code on your Mac")
        XCTAssertEqual(s.mood, .idle)
        XCTAssertTrue(s.detail.contains("Settings \u{203A} iPhone"))
        XCTAssertTrue(s.detail.contains("Away from this Mac"))
    }

    func testWaitingIsWorkingAndNamesTheMac() {
        let s = resolve(awaiting: true, waited: 30)
        XCTAssertEqual(s, .waiting(mac: "Studio Mac", code: "123456"))
        XCTAssertEqual(s.mood, .working)
        XCTAssertEqual(s.title, "Approve on Studio Mac")
    }

    func testApprovalCelebratesAndBeatsEverythingElse() {
        let s = resolve(awaiting: true, approved: "Studio Mac", failure: .refused)
        XCTAssertEqual(s, .approved(mac: "Studio Mac"))
        XCTAssertEqual(s.mood, .celebrating)
    }

    func testEveryFailureNeedsYouWithAPlainReason() {
        for f in [PairingFailure.refused, .notACode, .unreachable, .expired] {
            let s = resolve(failure: f)
            XCTAssertEqual(s.mood, .needsYou)
            XCTAssertFalse(s.title.isEmpty)
            XCTAssertFalse(s.detail.isEmpty)
        }
        XCTAssertEqual(resolve(failure: .refused).title, "Your Mac said no")
    }

    func testWaitingTooLongExpires() {
        XCTAssertEqual(resolve(awaiting: true, waited: PairingScreen.waitLimit - 1).mood, .working)
        XCTAssertEqual(resolve(awaiting: true, waited: PairingScreen.waitLimit), .failed(.expired))
    }

    func testMoodSpriteNamesAndDownloadURL() {
        XCTAssertEqual(PairingMood.needsYou.rawValue, "needs_you")
        XCTAssertEqual(PairingScreen.downloadURL, "https://sibhimanyu.github.io/squeak/")
        XCTAssertNotNil(URL(string: PairingScreen.downloadURL))
    }
}
