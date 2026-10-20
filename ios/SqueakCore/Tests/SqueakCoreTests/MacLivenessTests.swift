import XCTest
@testable import SqueakCore

final class MacLivenessTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_792_400_000)

    func testAMacThatNeverAnswersSaysNothingEitherWay() {
        // An older Mac writes no `state/alive`; the phone must not call it asleep.
        XCTAssertEqual(MacLiveness.read(aliveAt: nil, lookingSince: now.addingTimeInterval(-600), now: now), .unknown)
    }

    func testARecentAnswerIsAnswering() {
        XCTAssertEqual(MacLiveness.read(aliveAt: now.addingTimeInterval(-25), lookingSince: nil, now: now), .answering)
    }

    func testAnOldAnswerJustAfterOpeningIsStillBeingChecked() {
        // Back after 37 minutes: the answer on record is from the last visit, the new one is on its way.
        let old = now.addingTimeInterval(-37 * 60)
        XCTAssertEqual(MacLiveness.read(aliveAt: old, lookingSince: now.addingTimeInterval(-5), now: now), .checking)
    }

    func testNoAnswerAfterTheGraceIsASilentMac() {
        let old = now.addingTimeInterval(-37 * 60)
        XCTAssertEqual(MacLiveness.read(aliveAt: old, lookingSince: now.addingTimeInterval(-45), now: now), .silent(since: old))
        // A Mac that answered while the phone was open, then slept.
        let last = now.addingTimeInterval(-90)
        XCTAssertEqual(MacLiveness.read(aliveAt: last, lookingSince: now.addingTimeInterval(-600), now: now), .silent(since: last))
    }

    func testTheAnswerDecodesFromWhatTheMacSeals() throws {
        let key = Data(repeating: 7, count: 32).base64EncodedString()
        let box = try ChannelCrypto.seal(MacAlive(at: 1_792_400_000_123), key: key)
        let alive = try ChannelCrypto.open(MacAlive.self, box: box, key: key)
        XCTAssertEqual(alive.date.timeIntervalSince1970, 1_792_400_000.123, accuracy: 0.001)
    }
}
