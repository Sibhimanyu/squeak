import XCTest
@testable import SqueakCore

final class ClockSkewTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    func testNoReadingIsNoSkew() {
        XCTAssertEqual(ClockSkew().offset, 0)
    }

    func testAPhoneTwentySecondsFastReadsPlusTwenty() {
        var skew = ClockSkew()
        // The Mac stamped the result a third of a second before the phone read it, and the phone runs 20 s ahead.
        skew.observe(macAt: now.addingTimeInterval(-0.3), receivedAt: now.addingTimeInterval(20))
        XCTAssertEqual(skew.offset, 20.3, accuracy: 0.001)
    }

    func testAPhoneFiveMinutesSlowReadsMinusFive() {
        var skew = ClockSkew()
        skew.observe(macAt: now, receivedAt: now.addingTimeInterval(-300 + 0.5))
        XCTAssertEqual(skew.offset, -299.5, accuracy: 0.001)
    }

    func testTheSmallestReadingWinsSoASlowResultDoesNotMoveIt() {
        var skew = ClockSkew()
        skew.observe(macAt: now, receivedAt: now.addingTimeInterval(20 + 6))
        skew.observe(macAt: now.addingTimeInterval(60), receivedAt: now.addingTimeInterval(60 + 20.2))
        skew.observe(macAt: now.addingTimeInterval(120), receivedAt: now.addingTimeInterval(120 + 20 + 4))
        XCTAssertEqual(skew.offset, 20.2, accuracy: 0.001)
    }

    func testOldReadingsExpireSoAClockSetSinceIsNotBelieved() {
        var skew = ClockSkew()
        skew.observe(macAt: now, receivedAt: now.addingTimeInterval(20))
        // The person fixed the phone's clock; the next result says 0.
        let later = now.addingTimeInterval(ClockSkew.keep + 5)
        skew.observe(macAt: later, receivedAt: later.addingTimeInterval(0.2))
        XCTAssertEqual(skew.offset, 0.2, accuracy: 0.001)
    }

    func testEpochMillisecondsAsTheMacWritesThem() {
        var skew = ClockSkew()
        skew.observe(macMillis: 1_800_000_000_000, receivedAt: now.addingTimeInterval(300.25))
        XCTAssertEqual(skew.offset, 300.25, accuracy: 0.001)
    }

    func testOnlyTheNewestFewReadingsAreKept() {
        var skew = ClockSkew()
        for i in 0..<20 { skew.observe(macAt: now.addingTimeInterval(Double(i)), receivedAt: now.addingTimeInterval(Double(i) + 10 + Double(i))) }
        // Early (small) readings fell out of the window: the smallest left is the oldest kept.
        XCTAssertEqual(skew.offset, 10 + 12, accuracy: 0.001)
    }
}
