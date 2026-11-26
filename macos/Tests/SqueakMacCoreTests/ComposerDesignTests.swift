import SqueakMacCore
import XCTest

final class ComposerDesignTests: XCTestCase {
    func testChipTitleCutsAtAWordNeverMidWord() {
        let t = ComposerDesign.chipTitle("YouTube: shared Google sign-in + Studio fallback", maxCharacters: 28)
        XCTAssertEqual(t, "YouTube: shared Google…")
        XCTAssertEqual(ComposerDesign.chipTitle("Sign in with Zoom: core flow", maxCharacters: 20), "Sign in with Zoom…")
    }

    func testChipTitleShortEnoughIsUntouched() {
        XCTAssertEqual(ComposerDesign.chipTitle("Review the diff", maxCharacters: 28), "Review the diff")
    }

    func testChipTitleKeepsOneLongWordWhole() {
        XCTAssertEqual(ComposerDesign.chipTitle("Supercalifragilistic", maxCharacters: 8), "Supercalifragilistic")
    }

    func testGrowthStopsAtTheMaximumThenScrolls() {
        XCTAssertEqual(ComposerDesign.growth(lines: 0), .init(height: 34, scrolls: false))
        XCTAssertEqual(ComposerDesign.growth(lines: 3), .init(height: 78, scrolls: false))
        XCTAssertEqual(ComposerDesign.growth(lines: 8), .init(height: 188, scrolls: false))
        XCTAssertEqual(ComposerDesign.growth(lines: 30), .init(height: 188, scrolls: true))
    }
}
