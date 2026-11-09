import XCTest
@testable import SqueakUI

final class StableOrderTests: XCTestCase {
    private func keys(_ items: [String], _ previous: [String]) -> [String] {
        StableOrder.arrange(items, previous: previous) { $0 }
    }

    func testFirstLookIsNewestFirst() {
        XCTAssertEqual(keys(["c", "b", "a"], []), ["c", "b", "a"])
    }

    func testAChatThatWorkedDoesNotJumpToTheTop() {
        // "a" became the newest, but the page already showed c, b, a: it holds still.
        XCTAssertEqual(keys(["a", "c", "b"], ["c", "b", "a"]), ["c", "b", "a"])
    }

    func testANewChatGoesInAtTheTopAndAGoneOneIsDropped() {
        XCTAssertEqual(keys(["d", "a", "c"], ["c", "b", "a"]), ["d", "c", "a"])
    }
}
