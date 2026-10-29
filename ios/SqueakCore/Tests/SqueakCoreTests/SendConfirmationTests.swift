import XCTest
@testable import SqueakCore

final class SendConfirmationTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let d = UserDefaults(suiteName: "send-confirmation-\(UUID().uuidString)")!
        return d
    }

    func testDefaultsToOn() {
        XCTAssertTrue(SendConfirmation(defaults: defaults()).asksForFaceID)
        XCTAssertTrue(SendConfirmation().asksForFaceID)
    }

    func testRoundTripsThroughDefaults() {
        let d = defaults()
        SendConfirmation(asksForFaceID: false).save(to: d)
        XCTAssertFalse(SendConfirmation(defaults: d).asksForFaceID)
        SendConfirmation(asksForFaceID: true).save(to: d)
        XCTAssertTrue(SendConfirmation(defaults: d).asksForFaceID)
    }

    func testOffNeverNeedsConfirmationOnAskedOnlyWhenLocked() {
        var unlock = SendUnlock()
        XCTAssertTrue(SendConfirmation(asksForFaceID: true).needsConfirmation(unlock))
        XCTAssertFalse(SendConfirmation(asksForFaceID: false).needsConfirmation(unlock))
        unlock.authenticated()
        XCTAssertFalse(SendConfirmation(asksForFaceID: true).needsConfirmation(unlock))
    }

    func testOnlyTurningOffNeedsTheOwner() {
        XCTAssertTrue(SendConfirmation.needsOwnerCheck(turningOn: false))
        XCTAssertFalse(SendConfirmation.needsOwnerCheck(turningOn: true))
    }
}
