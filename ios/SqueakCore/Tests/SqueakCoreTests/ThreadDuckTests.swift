import XCTest
@testable import SqueakCore

final class ThreadDuckTests: XCTestCase {
    func testVectorsMatchTheSharedList() {
        XCTAssertEqual(ThreadDuck.vectors.count, 5)
        for v in ThreadDuck.vectors { XCTAssertEqual(ThreadDuck.colour(for: v.id).name, v.colour, v.id) }
    }

    func testBadgeAndDucklingSizesMatchTheMac() {
        XCTAssertEqual(ThreadDuck.badgeSize(duck: 28), 14)
        XCTAssertEqual(ThreadDuck.ducklingSize(parent: 18), 12.6)
    }
}
