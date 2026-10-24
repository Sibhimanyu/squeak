import XCTest
@testable import SqueakUI

final class ImageSizingTests: XCTestCase {
    func testWideImageFillsTheWidthAndKeepsItsRatio() {
        let s = ImageSizing.fit(natural: CGSize(width: 1600, height: 900), maxWidth: 300, maxHeight: 500)
        XCTAssertEqual(s.width, 300); XCTAssertEqual(s.height, 168) // 168.75 down
    }
    func testTallImageIsLimitedByHeightNotStretchedToWidth() {
        let s = ImageSizing.fit(natural: CGSize(width: 600, height: 1800), maxWidth: 300, maxHeight: 400)
        XCTAssertEqual(s.height, 400); XCTAssertEqual(s.width, 133) // 133.3 down
    }
    func testSmallImageIsNeverEnlarged() {
        XCTAssertEqual(ImageSizing.fit(natural: CGSize(width: 40, height: 20), maxWidth: 300, maxHeight: 400), CGSize(width: 40, height: 20))
    }
    func testRatioIsPreservedWithinARoundedPoint() {
        let n = CGSize(width: 1179, height: 2556)
        let s = ImageSizing.fit(natural: n, maxWidth: 340, maxHeight: 510)
        XCTAssertEqual(s.width / s.height, n.width / n.height, accuracy: 0.01)
        XCTAssertLessThanOrEqual(s.height, 510); XCTAssertLessThanOrEqual(s.width, 340)
    }
    func testDegenerateInputsGiveZero() {
        XCTAssertEqual(ImageSizing.fit(natural: .zero, maxWidth: 300, maxHeight: 300), .zero)
        XCTAssertEqual(ImageSizing.fit(natural: CGSize(width: 10, height: 10), maxWidth: 0, maxHeight: 300), .zero)
        XCTAssertEqual(ImageSizing.fit(natural: CGSize(width: CGFloat.infinity, height: 10), maxWidth: 300, maxHeight: 300), .zero)
    }
}
