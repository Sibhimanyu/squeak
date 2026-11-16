import XCTest
@testable import SqueakIcons

final class StatusMarkTests: XCTestCase {
    func testDotSizes() {
        XCTAssertEqual(StatusMark.dotFraction(.waiting(count: nil)), 0.40)
        XCTAssertEqual(StatusMark.dotFraction(.unread), 0.30)
    }
}

final class TideFitTests: XCTestCase {
    func testHeightFittingWidthRoundTrips() {
        for grid in [TideGlyph.Grid.mini, .mark, .large] {
            XCTAssertEqual(grid.width(height: grid.height(fittingWidth: 24)), 24, accuracy: 1e-9)
        }
    }
}

final class TidePixelTests: XCTestCase {
    func testChosenGridKeepsPixelsAtLeastOnePoint() {
        for h in stride(from: 3.0, through: 30.0, by: 0.25) {
            let height = CGFloat(h)
            XCTAssertGreaterThanOrEqual(TideGlyph.Grid.preset(forHeight: height).side(height: height), 1, "height \(h)")
        }
    }
}
