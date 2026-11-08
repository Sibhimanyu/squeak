import XCTest
@testable import SqueakUI

final class HapticsTests: XCTestCase {
    func testEveryEventHasAFeeling() {
        for event in HapticEvent.allCases { XCTAssertNotNil(HapticMap.table[event], "\(event)") }
    }

    func testTheMapIsTheOwnersTable() {
        for e in [HapticEvent.tap, .navigate, .menu, .toggle, .refresh] { XCTAssertEqual(HapticMap.kind(e), .light) }
        for e in [HapticEvent.tab, .segment, .pick, .option] { XCTAssertEqual(HapticMap.kind(e), .selection) }
        for e in [HapticEvent.send, .queue, .steer, .stop, .answer, .approve] { XCTAssertEqual(HapticMap.kind(e), .firm) }
        XCTAssertEqual(HapticMap.kind(.confirmed), .success)
        XCTAssertEqual(HapticMap.kind(.notConfirmed), .warning)
        XCTAssertEqual(HapticMap.kind(.refused), .error)
    }

    func testOneControlNeverBuzzesTwice() {
        XCTAssertTrue(HapticMap.plays(.light, sinceLast: nil, last: nil))
        XCTAssertFalse(HapticMap.plays(.light, sinceLast: 0.03, last: .light))
        XCTAssertFalse(HapticMap.plays(.selection, sinceLast: 0.03, last: .light))
        XCTAssertTrue(HapticMap.plays(.light, sinceLast: 0.5, last: .light))
    }

    func testAStrongerFeelingAndTheMacsWordAreNotSwallowed() {
        XCTAssertTrue(HapticMap.plays(.firm, sinceLast: 0.01, last: .light))
        XCTAssertFalse(HapticMap.plays(.light, sinceLast: 0.01, last: .firm))
        XCTAssertTrue(HapticMap.plays(.success, sinceLast: 0.01, last: .firm))
        XCTAssertTrue(HapticMap.plays(.error, sinceLast: 0.0, last: .error))
    }
}

final class HeldTests: XCTestCase {
    func testShowsTheChoiceUntilReleased() {
        var held = Held<Bool>()
        XCTAssertEqual(held.shown(false), false)
        let token = held.hold(true)
        XCTAssertEqual(held.shown(false), true)
        held.release(token)
        XCTAssertEqual(held.shown(false), false)
    }

    func testAnOlderAnswerNeverReleasesANewerChoice() {
        var held = Held<String>()
        let first = held.hold("40"), second = held.hold("80")
        held.release(first)
        XCTAssertEqual(held.shown("auto"), "80")
        held.release(second)
        XCTAssertEqual(held.shown("auto"), "auto")
    }

    func testTheMacCatchingUpReleases() {
        var held = Held<Bool>()
        _ = held.hold(true)
        held.caughtUp()
        XCTAssertEqual(held.shown(false), false)
    }
}
