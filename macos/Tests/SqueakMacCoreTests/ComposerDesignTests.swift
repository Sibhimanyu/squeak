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

    func testFieldHeightRoundsToWholeLinesAndCaps() {
        XCTAssertEqual(ComposerDesign.fieldHeight(content: 0), .init(height: 34, scrolls: false))
        XCTAssertEqual(ComposerDesign.fieldHeight(content: 34), .init(height: 34, scrolls: false))
        XCTAssertEqual(ComposerDesign.fieldHeight(content: 78), .init(height: 78, scrolls: false))
        XCTAssertEqual(ComposerDesign.fieldHeight(content: 600), .init(height: 188, scrolls: true))
        XCTAssertEqual(ComposerDesign.fieldHeight(content: 34, minLines: 3), .init(height: 78, scrolls: false))
    }

    func testStatusLineShowsOnlyWithBackgroundWork() {
        XCTAssertFalse(ComposerDesign.showsStatus(barText: nil))
        XCTAssertTrue(ComposerDesign.showsStatus(barText: "2 ducklings working"))
        XCTAssertEqual(ComposerDesign.statusLead(barText: "2 ducklings working", readyLine: "Ready · 2 ducklings running"), "Ready · 2 ducklings running")
        XCTAssertEqual(ComposerDesign.statusLead(barText: "Background work finished", readyLine: nil), "Background work finished")
    }

    func testChipFittingTriesEveryChipThenFewerWithOverflow() {
        XCTAssertEqual(ComposerDesign.fitOptions(count: 3), [3, 2, 1, 0])
        XCTAssertEqual(ComposerDesign.fitOptions(count: 0), [0])
        XCTAssertNil(ComposerDesign.overflowLabel(total: 3, shown: 3))
        XCTAssertEqual(ComposerDesign.overflowLabel(total: 3, shown: 1), "+2")
    }

    func testSendHintOnlyWhileWorkingWithWords() {
        XCTAssertNil(ComposerDesign.sendHint(working: false, hasText: true, primary: .steer))
        XCTAssertNil(ComposerDesign.sendHint(working: true, hasText: false, primary: .steer))
        XCTAssertEqual(ComposerDesign.sendHint(working: true, hasText: true, primary: .steer), "Steers now · ⌘↩ to queue")
        XCTAssertEqual(ComposerDesign.sendHint(working: true, hasText: true, primary: .queue), "Queues · ⌘↩ to steer now")
    }
}
