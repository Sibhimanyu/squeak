import XCTest
@testable import SqueakCore

final class ThreadDuckTests: XCTestCase {
    func testVectorsMatchTheSharedList() {
        XCTAssertEqual(ThreadDuck.vectors.count, 5)
        for v in ThreadDuck.vectors { XCTAssertEqual(ThreadDuck.colour(for: v.id).name, v.colour, v.id) }
    }

    func testPondHueParsesNamesAndLogoHues() {
        XCTAssertEqual(ThreadDuck.pondHue(named: "teal"), 175)
        XCTAssertEqual(ThreadDuck.pondHue(named: "hue:140"), 140)
        XCTAssertEqual(ThreadDuck.pondHue(named: "hue:30"), 24)
        XCTAssertEqual(ThreadDuck.pondHue(named: "hue:70"), 75)
        XCTAssertNil(ThreadDuck.pondHue(named: "hue:400"))
        XCTAssertNil(ThreadDuck.pondHue(named: "mauve"))
    }

    func testBadgeAndDucklingSizesMatchTheMac() {
        XCTAssertEqual(ThreadDuck.badgeSize(duck: 28), 14)
        XCTAssertEqual(ThreadDuck.ducklingSize(parent: 18), 12.6)
    }
}
