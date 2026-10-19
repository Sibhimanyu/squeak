import XCTest
@testable import SqueakCore

final class UsageFormatTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_790_000_000)
    func iso(_ offset: TimeInterval) -> String { ISO8601DateFormatter().string(from: now.addingTimeInterval(offset)) }

    func testResetsInHoursAndMinutes() {
        XCTAssertEqual(UsageFormat.resets(iso(2 * 3600 + 10 * 60), now: now), "resets in 2h 10m")
        XCTAssertEqual(UsageFormat.resets(iso(3 * 3600), now: now), "resets in 3h")
        XCTAssertEqual(UsageFormat.resets(iso(25 * 60), now: now), "resets in 25m")
        XCTAssertEqual(UsageFormat.resets(iso(5 * 86400 + 3 * 3600), now: now), "resets in 5d 3h")
    }

    func testAWindowThatHasResetIsNotPresentedAsCurrent() {
        XCTAssertEqual(UsageFormat.resets(iso(-60), now: now), "has reset since")
    }

    func testAgeAppearsOnlyOnceAReadingIsStale() {
        XCTAssertNil(UsageFormat.asOf(iso(-1800), now: now))
        XCTAssertEqual(UsageFormat.asOf(iso(-3 * 3600), now: now), "as of 3 hours ago")
        XCTAssertEqual(UsageFormat.asOf(iso(-3600), now: now), "as of 1 hour ago")
        XCTAssertEqual(UsageFormat.asOf(iso(-3 * 86400), now: now), "as of 3 days ago")
    }

    func testPercentAndBar() {
        XCTAssertEqual(UsageFormat.used(41.6), "42% used")
        XCTAssertEqual(UsageFormat.fraction(140), 1)
        XCTAssertEqual(UsageFormat.fraction(-3), 0)
    }
    func testAWindowThatHasResetReadsResetWithAnEmptyBar() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let past = ISO8601DateFormatter().string(from: now.addingTimeInterval(-60))
        let future = ISO8601DateFormatter().string(from: now.addingTimeInterval(3600))
        XCTAssertEqual(UsageFormat.used(76, resetsAt: past, now: now), "Reset")
        XCTAssertEqual(UsageFormat.fraction(76, resetsAt: past, now: now), 0)
        XCTAssertEqual(UsageFormat.used(76, resetsAt: future, now: now), "76% used")
        XCTAssertEqual(UsageFormat.fraction(76, resetsAt: future, now: now), 0.76, accuracy: 0.0001)
    }
}
