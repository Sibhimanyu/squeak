import XCTest
@testable import SqueakIcons

final class TideClockPolicyTests: XCTestCase {
    func testIdleWithoutSubscribers() {
        XCTAssertFalse(TideClockPolicy().shouldRun)
    }
    func testRunsWhileSubscribedAndVisible() {
        var p = TideClockPolicy(); p.subscribe(); p.subscribe()
        XCTAssertTrue(p.shouldRun)
        p.unsubscribe(); XCTAssertTrue(p.shouldRun)
        p.unsubscribe(); XCTAssertFalse(p.shouldRun)
    }
    func testPausesWhenOccludedOrHidden() {
        var p = TideClockPolicy(); p.subscribe()
        p.occluded = true; XCTAssertFalse(p.shouldRun)
        p.occluded = false; p.hidden = true; XCTAssertFalse(p.shouldRun)
        p.hidden = false; XCTAssertTrue(p.shouldRun)
    }
    func testUnsubscribeNeverGoesNegative() {
        var p = TideClockPolicy(); p.unsubscribe(); p.subscribe()
        XCTAssertEqual(p.subscribers, 1)
    }
}
