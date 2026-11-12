import XCTest
@testable import SqueakMacCore

final class SetupSceneTests: XCTestCase {
    func testMoodArtAndMotionFollowDesign() {
        XCTAssertEqual(SetupDuckMood.idle.spriteFile, "duck.png")
        XCTAssertEqual(SetupDuckMood.needsYou.spriteFile, "duck-needs_you.png")
        XCTAssertEqual(SetupDuckMood.asleep.period, 5.0)
        XCTAssertEqual(SetupDuckMood.working.period, 1.1)
        XCTAssertEqual(SetupDuckMood.celebrating.motion, .hop)
        XCTAssertEqual(SetupDuckMood.needsYou.motion, .wobble)
        XCTAssertEqual(SetupDuckMood.offline.motion, .still)
        XCTAssertEqual(MotionToken.standard.duration, 0.2)
    }
}
