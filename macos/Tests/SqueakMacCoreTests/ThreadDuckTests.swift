import XCTest
@testable import SqueakMacCore

final class ThreadDuckTests: XCTestCase {
    func testVectorsMatchTheSharedList() {
        XCTAssertEqual(ThreadDuck.vectors.count, 5)
        for v in ThreadDuck.vectors { XCTAssertEqual(ThreadDuck.colour(for: v.id).name, v.colour, v.id) }
    }

    func testStableAndInPalette() {
        for id in ["x", "y", "a long id with spaces and ünïcode"] {
            XCTAssertEqual(ThreadDuck.index(for: id), ThreadDuck.index(for: id))
            XCTAssertTrue((0..<PondColours.all.count).contains(ThreadDuck.index(for: id)))
        }
    }

    func testNoPaletteColourIsInTheDucksBand() {
        for c in PondColours.all { XCTAssertFalse(PondTint.duckBand.contains(c.hue), c.name) }
    }

    func testBadgeAndDucklingSizes() {
        XCTAssertEqual(ThreadDuck.badgeSize(duck: 28), 14)
        XCTAssertEqual(ThreadDuck.ducklingSize(parent: 18), 12.6)
    }
}
