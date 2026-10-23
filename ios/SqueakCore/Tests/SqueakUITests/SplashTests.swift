import XCTest
@testable import SqueakUI

final class SplashTests: XCTestCase {
    func testShowsWhileWaitingForAFreshView() {
        XCTAssertTrue(Splash.shows(paired: true, suppressed: false, freshSince: nil, elapsed: 0.1))
        XCTAssertTrue(Splash.shows(paired: true, suppressed: false, freshSince: false, elapsed: 2.4))
    }

    func testGoesAsSoonAsAFreshViewArrivesWithNoMinimum() {
        XCTAssertFalse(Splash.shows(paired: true, suppressed: false, freshSince: true, elapsed: 0))
    }

    func testCapsAtTwoAndAHalfSeconds() {
        XCTAssertFalse(Splash.shows(paired: true, suppressed: false, freshSince: nil, elapsed: 2.5))
    }

    func testNeverForUnpairedDemoOrScreenshotLaunches() {
        XCTAssertFalse(Splash.shows(paired: false, suppressed: false, freshSince: nil, elapsed: 0))
        XCTAssertFalse(Splash.shows(paired: true, suppressed: true, freshSince: nil, elapsed: 0))
    }

    func testReturnShowsOnlyAfterFiveMinutesAway() {
        XCTAssertFalse(Splash.returnShows(away: 299))
        XCTAssertTrue(Splash.returnShows(away: 301))
    }
}
