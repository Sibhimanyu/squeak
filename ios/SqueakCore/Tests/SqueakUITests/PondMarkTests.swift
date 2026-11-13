import XCTest
@testable import SqueakUI

final class PondMarkTests: XCTestCase {
    func testHueFromIdSkipsTheDuckBandAndIsStable() {
        XCTAssertEqual(PondMarkTint.hue(for: "abc"), PondMarkTint.hue(for: "abc"))
        for id in ["a", "b", "proj-1", "greenroom", "x9", "abc"] {
            XCTAssertFalse(PondMarkTint.duckBand.contains(PondMarkTint.hue(for: id)), id)
        }
    }

    func testChosenColourWinsAndLogoHuesNudgeOutOfTheBand() {
        XCTAssertEqual(PondMarkTint.hue(colour: "teal", id: "abc"), 175)
        XCTAssertEqual(PondMarkTint.hue(colour: "hue:40", id: "abc"), 24)
        XCTAssertEqual(PondMarkTint.hue(colour: "nonsense", id: "abc"), PondMarkTint.hue(for: "abc"))
    }

    func testTheMarkIsTheFirstLetterUppercased() {
        XCTAssertEqual(PondMarkTint.letter("greenroom"), "G")
        XCTAssertEqual(PondMarkTint.letter("  hong kong"), "H")
    }
}
