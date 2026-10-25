import XCTest
@testable import SqueakCore

final class MacLivenessTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_792_400_000)

    func testAMacThatNeverAnswersSaysNothingEitherWay() {
        // An older Mac writes no `state/alive`; the phone must not call it asleep.
        XCTAssertEqual(MacLiveness.read(aliveAt: nil, lookingSince: now.addingTimeInterval(-600), now: now), .unknown)
    }

    func testARecentAnswerIsAnswering() {
        XCTAssertEqual(MacLiveness.read(aliveAt: now.addingTimeInterval(-24), lookingSince: nil, now: now), .answering)
        XCTAssertEqual(MacLiveness.read(aliveAt: now.addingTimeInterval(-26), lookingSince: nil, now: now), .silent(since: now.addingTimeInterval(-26)))
        XCTAssertEqual(MacLiveness.answerWindow, 25)
        XCTAssertEqual(MacLiveness.pingEvery, 10)
    }

    func testAnOldAnswerJustAfterOpeningIsStillBeingChecked() {
        // Back after 37 minutes: the answer on record is from the last visit, the new one is on its way.
        let old = now.addingTimeInterval(-37 * 60)
        XCTAssertEqual(MacLiveness.read(aliveAt: old, lookingSince: now.addingTimeInterval(-5), now: now), .checking)
    }

    func testNoAnswerAfterTheGraceIsASilentMac() {
        let old = now.addingTimeInterval(-37 * 60)
        XCTAssertEqual(MacLiveness.read(aliveAt: old, lookingSince: now.addingTimeInterval(-20), now: now), .silent(since: old))
        // A Mac that answered while the phone was open, then slept.
        let last = now.addingTimeInterval(-40)
        XCTAssertEqual(MacLiveness.read(aliveAt: last, lookingSince: now.addingTimeInterval(-600), now: now), .silent(since: last))
    }

    func testTheAnswerDecodesFromWhatTheMacSeals() throws {
        let key = Data(repeating: 7, count: 32).base64EncodedString()
        let box = try ChannelCrypto.seal(MacAlive(at: 1_792_400_000_123), key: key)
        let alive = try ChannelCrypto.open(MacAlive.self, box: box, key: key)
        XCTAssertEqual(alive.date.timeIntervalSince1970, 1_792_400_000.123, accuracy: 0.001)
    }
}

final class MacHeatTests: XCTestCase {
    func testHeatReadsAsOneLineAndOlderMacsSendNone() throws {
        let json = #"{"v":1,"mac":"Mac","generatedAt":"2026-10-23T08:00:00Z","duck":{"blockedCount":0,"workingCount":0},"sessions":[],"macHeat":{"level":"warm","chip":91,"battery":41,"fansRpm":[7800,7700],"fansMax":true,"fanControl":true}}"#
        let heat = try XCTUnwrap(try JSONDecoder().decode(PhoneSnapshot.self, from: Data(json.utf8)).macHeat)
        XCTAssertEqual(heat.reading, "Chip 91°C · battery 41°C · fans 7,800 rpm, full")
        XCTAssertEqual(PhoneSnapshot.MacHeat(level: "ok", chip: 50, fansRpm: [0]).reading, "Chip 50°C · fans off")
        XCTAssertNil(PhoneSnapshot.MacHeat(level: "ok").reading)
        let old = #"{"v":1,"mac":"Mac","generatedAt":"2026-10-23T08:00:00Z","duck":{"blockedCount":0,"workingCount":0},"sessions":[]}"#
        XCTAssertNil(try JSONDecoder().decode(PhoneSnapshot.self, from: Data(old.utf8)).macHeat)
    }
}
