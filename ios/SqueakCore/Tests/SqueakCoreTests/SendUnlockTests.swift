import Foundation
import XCTest
@testable import SqueakCore

final class SendUnlockTests: XCTestCase {
    let t0 = Date(timeIntervalSince1970: 1_000_000)

    func testAsksOnceThenNotWhileInUse() {
        var unlock = SendUnlock()
        XCTAssertTrue(unlock.needsAuthentication)
        unlock.authenticated()
        XCTAssertFalse(unlock.needsAuthentication)
    }

    func testABriefTripAwayKeepsItUnlocked() {
        var unlock = SendUnlock()
        unlock.authenticated()
        unlock.backgrounded(at: t0)
        unlock.foregrounded(at: t0.addingTimeInterval(SendUnlock.away - 1))
        XCTAssertFalse(unlock.needsAuthentication)
    }

    func testLongerAwayAsksAgain() {
        var unlock = SendUnlock()
        unlock.authenticated()
        unlock.backgrounded(at: t0)
        unlock.foregrounded(at: t0.addingTimeInterval(SendUnlock.away + 1))
        XCTAssertTrue(unlock.needsAuthentication)
    }

    func testTimeAwayIsCountedFromTheFirstBackgrounding() {
        var unlock = SendUnlock()
        unlock.authenticated()
        unlock.backgrounded(at: t0)
        unlock.backgrounded(at: t0.addingTimeInterval(SendUnlock.away)) // a second pause must not restart the clock
        unlock.foregrounded(at: t0.addingTimeInterval(SendUnlock.away + 1))
        XCTAssertTrue(unlock.needsAuthentication)
    }
}
