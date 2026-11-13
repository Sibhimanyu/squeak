import CoreGraphics
import XCTest
@testable import SqueakMacCore

final class PictureLayoutTests: XCTestCase {
    func testWideScreenshotFitsHeightCap() {
        let s = PictureLayout.size(image: CGSize(width: 2000, height: 1000), maxWidth: 600, maxHeight: 160)
        XCTAssertEqual(s, CGSize(width: 320, height: 160))
    }
    func testNarrowWidthCapWins() {
        let s = PictureLayout.size(image: CGSize(width: 2000, height: 1000), maxWidth: 200, maxHeight: 160)
        XCTAssertEqual(s, CGSize(width: 200, height: 100))
    }
    func testNeverEnlarged() {
        XCTAssertEqual(PictureLayout.size(image: CGSize(width: 40, height: 30), maxWidth: 600, maxHeight: 160), CGSize(width: 40, height: 30))
    }
    func testUnknownImageGetsFallbackShape() {
        XCTAssertEqual(PictureLayout.size(image: nil, maxWidth: 600, maxHeight: 160), PictureLayout.fallback)
        XCTAssertEqual(PictureLayout.size(image: nil, maxWidth: 600, maxHeight: 60).height, 60)
    }
    func testStepThumbnailIsCompact() {
        let s = PictureLayout.size(image: CGSize(width: 1500, height: 900), maxWidth: 600, maxHeight: PictureLayout.stepMaxHeight)
        XCTAssertLessThanOrEqual(s.height, 64)
    }
    func testRowsWrapAndSizeIncludesEveryRow() {
        let a = CGSize(width: 200, height: 100), b = CGSize(width: 200, height: 160), c = CGSize(width: 100, height: 50)
        let r = PictureLayout.rows(sizes: [a, b, c], maxWidth: 420, spacing: 8)
        XCTAssertEqual(r.frames[1].minX, 208)
        XCTAssertEqual(r.frames[2].minY, 168)
        XCTAssertEqual(r.size, CGSize(width: 408, height: 218))
        XCTAssertEqual(PictureLayout.rows(sizes: [], maxWidth: 100).size, .zero)
    }
    func testAttachedMatchesRelativeAndAbsolute() {
        let rel = ".context/attachments/ab/image-1.png"
        XCTAssertTrue(PictureLayout.isAttached("/Users/x/ws/" + rel, attached: [rel]))
        XCTAssertTrue(PictureLayout.isAttached(rel, attached: ["/Users/x/ws/" + rel]))
        XCTAssertFalse(PictureLayout.isAttached("/Users/x/ws/.context/attachments/ab/image-2.png", attached: [rel]))
        XCTAssertFalse(PictureLayout.isAttached("/Users/x/ws/other.png", attached: []))
    }
    func testAttachedPathsComeFromTokens() {
        let text = ImageAttachments.compose("look", refs: [".context/attachments/a/image-1.png"])
        XCTAssertEqual(PictureLayout.attachedPaths(inTexts: [text, "plain"]), [".context/attachments/a/image-1.png"])
    }
}
