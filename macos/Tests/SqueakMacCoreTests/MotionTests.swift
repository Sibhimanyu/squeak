import XCTest
@testable import SqueakMacCore

final class MotionTests: XCTestCase {
    func testTokenValuesFollowDesign() {
        XCTAssertEqual(MotionToken.quick.duration, 0.12)
        XCTAssertEqual(MotionToken.standard.duration, 0.20)
        XCTAssertEqual(MotionToken.emphasis.duration, 0.32)
        XCTAssertEqual(MotionToken.none.duration, 0)
        XCTAssertFalse(MotionRules.pressDownAnimated)
        XCTAssertLessThanOrEqual(MotionRules.maxRise, 6)
    }

    func testReduceMotionRemovesMovementAndCapsDuration() {
        for token in MotionToken.allCases {
            let r = token.resolved(reduceMotion: true)
            XCTAssertFalse(r.allowsMovement)
            XCTAssertLessThanOrEqual(r.duration, 0.12)
        }
        XCTAssertEqual(MotionToken.standard.resolved(reduceMotion: true).duration, 0.12)
        XCTAssertEqual(MotionToken.quick.resolved(reduceMotion: true).duration, 0.12)
        XCTAssertTrue(MotionToken.standard.resolved(reduceMotion: false).allowsMovement)
        XCTAssertFalse(MotionToken.none.resolved(reduceMotion: false).allowsMovement)
    }

    /// No raw spring or timed curve outside the Motion files: every animation is a token.
    func testNoRawAnimationCurvesOutsideMotion() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources")
        let banned = [".spring(", ".easeInOut(duration:", ".easeOut(duration:", ".easeIn(duration:", ".snappy(", ".bouncy(", ".smooth("]
        var offenders: [String] = []
        let walker = try XCTUnwrap(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
        for case let url as URL in walker where url.pathExtension == "swift" && !url.lastPathComponent.hasPrefix("Motion") {
            let text = try String(contentsOf: url, encoding: .utf8)
            for (n, line) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
                let code = line.components(separatedBy: "//").first ?? ""
                if banned.contains(where: code.contains) { offenders.append("\(url.lastPathComponent):\(n + 1)") }
            }
        }
        XCTAssertEqual(offenders, [], "Use Motion.quick/.standard/.emphasis (DESIGN.md §7)")
    }
}
