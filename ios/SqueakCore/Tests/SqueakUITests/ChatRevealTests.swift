import XCTest
@testable import SqueakUI

final class ChatRevealTests: XCTestCase {
    func testNothingShownBeforeRows() {
        var reveal = ChatReveal()
        reveal.sample(height: 300, ready: false, at: 0)
        XCTAssertFalse(reveal.decide(at: 5))
    }

    func testShownOnceHeightHeldStill() {
        var reveal = ChatReveal()
        reveal.sample(height: 300, ready: true, at: 0)
        XCTAssertFalse(reveal.decide(at: 0.05))
        XCTAssertTrue(reveal.decide(at: 0.08))
    }

    func testEachChangeRestartsTheQuietPeriod() {
        var reveal = ChatReveal()
        reveal.sample(height: 300, ready: true, at: 0)
        reveal.sample(height: 420, ready: true, at: 0.06)
        XCTAssertFalse(reveal.decide(at: 0.12))
        reveal.sample(height: 900, ready: true, at: 0.13)
        XCTAssertFalse(reveal.decide(at: 0.20))
        XCTAssertTrue(reveal.decide(at: 0.22))
    }

    func testRoundingIsNotGrowth() {
        var reveal = ChatReveal()
        reveal.sample(height: 300, ready: true, at: 0)
        reveal.sample(height: 300.3, ready: true, at: 0.05)
        XCTAssertTrue(reveal.decide(at: 0.08))
    }

    func testCapShowsAChatThatKeepsGrowing() {
        var reveal = ChatReveal()
        var t = 0.0
        var h = 300.0
        while t < 0.49 { reveal.sample(height: h, ready: true, at: t); XCTAssertFalse(reveal.decide(at: t)); t += 0.03; h += 20 }
        reveal.sample(height: h, ready: true, at: 0.5)
        XCTAssertTrue(reveal.decide(at: 0.5))
    }

    func testShownLatches() {
        var reveal = ChatReveal()
        reveal.sample(height: 300, ready: true, at: 0)
        XCTAssertTrue(reveal.decide(at: 0.1))
        reveal.sample(height: 900, ready: true, at: 0.11)
        XCTAssertTrue(reveal.decide(at: 0.11))
    }

    func testReadyWithoutAnyHeightChangeStillShows() {
        var reveal = ChatReveal()
        reveal.markReady(at: 1)
        XCTAssertFalse(reveal.decide(at: 1.02))
        XCTAssertTrue(reveal.decide(at: 1.08))
    }
}
