import XCTest
@testable import SqueakIcons

final class StatusMarkTests: XCTestCase {
    func testNoDots() {
        XCTAssertEqual(StatusMark.glyphFraction(.waiting(count: nil)), 0.85)
        XCTAssertEqual(StatusMark.glyphFraction(.unread), 0)
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
    static let named: [TideGlyph.Grid] = [.micro, .mini, .medium, .compact, .mark, .stream, .large, .fitting(width: 24, rows: 4), .fitting(width: 34, rows: 4)]

    /// One cell pitch for every glyph: whatever the grid, the cell is the global pitch and the size is cols x pitch.
    func testEveryGridHasTheSameCellPitch() {
        for g in Self.named {
            XCTAssertEqual(g.side + g.gap, TideGlyph.pitch, accuracy: 1e-9, "\(g)")
            XCTAssertEqual(g.size.width, CGFloat(g.cols) * TideGlyph.pitch - g.gap, accuracy: 1e-9)
            XCTAssertEqual(g.size.height, CGFloat(g.rows) * TideGlyph.pitch - g.gap, accuracy: 1e-9)
            // Drawn through the frame path: the pixel side at the glyph's own height is the same one.
            XCTAssertEqual(g.pitch(height: g.size.height), TideGlyph.pitch, accuracy: 1e-9, "\(g)")
            XCTAssertGreaterThanOrEqual(g.side, 1)
        }
    }

    func testFittingNeverOverflowsItsSlot() {
        for w in stride(from: 12.0, through: 80, by: 1) {
            XCTAssertLessThanOrEqual(TideGlyph.Grid.fitting(width: CGFloat(w), rows: 4).size.width, max(CGFloat(w), 3 * TideGlyph.pitch))
        }
    }
}
