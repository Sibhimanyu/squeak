import XCTest
@testable import SqueakIcons

final class GlyphPresentationTests: XCTestCase {
    func testOnlyWorkingDrawsAGlyph() {
        XCTAssertEqual(GlyphPresentation.of(working: false, reduceMotion: false), .none)
        XCTAssertEqual(GlyphPresentation.of(working: false, reduceMotion: true), .none)
        XCTAssertEqual(GlyphPresentation.of(working: true, reduceMotion: false), .animatedGlyph)
    }

    func testReduceMotionNeverFreezesTheGlyph() {
        XCTAssertEqual(GlyphPresentation.of(working: true, reduceMotion: true), .reduceMotionIcon)
    }
}
