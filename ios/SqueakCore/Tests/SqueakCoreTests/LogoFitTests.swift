import XCTest
@testable import SqueakCore

final class LogoFitTests: XCTestCase {
    private func image(_ w: Int, _ h: Int, ground: [UInt8], _ paint: (Int, Int) -> [UInt8]?) -> [UInt8] {
        var out: [UInt8] = []
        for y in 0..<h { for x in 0..<w { out += paint(x, y) ?? ground } }
        return out
    }
    private let clear: [UInt8] = [0, 0, 0, 0]
    private let white: [UInt8] = [255, 255, 255, 255]
    private let black: [UInt8] = [0, 0, 0, 255]

    func testFullBleedGlyphOnTransparentShrinks() {
        let px = image(64, 64, ground: clear) { x, y in (x < 6 && y < 6) || (x >= 58 && y >= 58) ? white : nil }
        let fit = LogoFit.compute(rgba: px, width: 64, height: 64)
        XCTAssertNil(fit.background)
        XCTAssertEqual(Double(fit.scale), 0.64, accuracy: 0.02)
    }

    func testCircularLogoAlreadyInsideIsNotShrunkBelowMargin() {
        let px = image(64, 64, ground: clear) { x, y in
            let dx = Double(x) + 0.5 - 32, dy = Double(y) + 0.5 - 32
            return (dx * dx + dy * dy).squareRoot() <= 28 ? white : nil
        }
        XCTAssertEqual(Double(LogoFit.compute(rgba: px, width: 64, height: 64).scale), 1, accuracy: 0.0001)
        let small = image(64, 64, ground: clear) { x, y in abs(x - 32) < 10 && abs(y - 32) < 10 ? white : nil }
        XCTAssertEqual(LogoFit.compute(rgba: small, width: 64, height: 64).scale, 1)
    }

    func testWhiteGlyphOnBlackGroundReachingCorners() {
        let px = image(64, 64, ground: black) { x, y in x < 4 && y < 4 ? white : nil }
        let fit = LogoFit.compute(rgba: px, width: 64, height: 64)
        XCTAssertNotNil(fit.background)
        XCTAssertEqual(fit.background?.r ?? 1, 0, accuracy: 0.2)
        XCTAssertLessThan(fit.scale, 0.8)
    }

    func testOpaqueGroundNoiseIsNotArtwork() {
        let px = image(64, 64, ground: [200, 30, 30, 255]) { x, y in (x + y) % 2 == 0 ? [205, 28, 33, 255] : nil }
        XCTAssertEqual(LogoFit.compute(rgba: px, width: 64, height: 64).scale, 1)
    }

    func testOpaqueImageWithNoDetectableBackgroundUsesFullExtent() {
        let px = image(32, 32, ground: [90, 90, 90, 255]) { x, y in
            if x == 0 && y == 0 { return [255, 0, 0, 255] }
            if x == 31 && y == 0 { return [0, 255, 0, 255] }
            if x == 0 && y == 31 { return [0, 0, 255, 255] }
            if x == 31 && y == 31 { return [255, 255, 0, 255] }
            return nil
        }
        let fit = LogoFit.compute(rgba: px, width: 32, height: 32)
        XCTAssertNil(fit.background)
        XCTAssertEqual(Double(fit.scale), 0.64, accuracy: 0.02)
    }

    func testEmptyImageIsUnchanged() {
        XCTAssertEqual(LogoFit.compute(rgba: [], width: 0, height: 0), .unchanged)
        let blank = image(16, 16, ground: clear) { _, _ in nil }
        XCTAssertEqual(LogoFit.compute(rgba: blank, width: 16, height: 16).scale, 1)
    }

    func testNonSquareMeasuresAgainstTheShorterSide() {
        let px = image(96, 48, ground: clear) { x, y in (x < 4 || x >= 92) && abs(y - 24) < 3 ? white : nil }
        XCTAssertEqual(LogoFit.compute(rgba: px, width: 96, height: 48).scale, LogoFit.minimumScale)
        let inside = image(96, 48, ground: clear) { x, y in abs(x - 48) < 8 && abs(y - 24) < 8 ? white : nil }
        XCTAssertEqual(LogoFit.compute(rgba: inside, width: 96, height: 48).scale, 1)
    }
}
