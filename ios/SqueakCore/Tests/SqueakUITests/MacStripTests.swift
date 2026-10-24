import XCTest
import SqueakCore
@testable import SqueakUI

final class MacStripTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let us = Locale(identifier: "en_US")

    private func strip(awake: MacStrip.Awake? = nil, power: PhoneSnapshot.MacPower? = nil,
                       liveness: MacLiveness = .answering, sleepProblem: String? = nil,
                       lastEnd: PhoneSnapshot.AwakeEnd? = nil, offered: Bool = true) -> MacStrip? {
        MacStrip.compose(awake: awake, power: power, liveness: liveness, sleepProblem: sleepProblem,
                         lastEnd: lastEnd, offered: offered, now: now, locale: us)
    }

    private let battery = PhoneSnapshot.MacPower(percent: 64, onBattery: true, watts: 12, lidClosed: false)

    func testTimedAwakeWithLidClosedAndBattery() throws {
        let s = try XCTUnwrap(strip(awake: .init(until: now.addingTimeInterval(80 * 60), lid: "on"), power: battery))
        XCTAssertEqual(s.tone, .awake)
        XCTAssertTrue(s.lines[0].hasPrefix("Awake until "), s.lines[0])
        XCTAssertTrue(s.lines[0].hasSuffix("· 1h 20m left"), s.lines[0])
        XCTAssertEqual(s.lines[1], "Lid closed OK · 64% on battery")
        XCTAssertTrue(s.spoken.hasPrefix("Mac awake."))
    }

    func testAwakeWithNoEnd() throws {
        let s = try XCTUnwrap(strip(awake: .init(until: nil), power: .init(percent: 100, onBattery: false, watts: nil, lidClosed: false)))
        XCTAssertEqual(s.lines, ["Kept awake until you end it", "Lid open only · 100% plugged in"])
    }

    func testLidFailedIsVioletToneNotAwake() throws {
        let s = try XCTUnwrap(strip(awake: .init(until: nil, lid: "failed"), power: battery))
        XCTAssertEqual(s.tone, .failed)
        XCTAssertTrue(s.lines[1].hasPrefix("Lid closed didn't turn on"))
    }

    func testSafetySentenceReplacesBattery() throws {
        let s = try XCTUnwrap(strip(awake: .init(until: nil, lid: "on", safety: "Low Power Mode on · Battery at 38%"), power: battery))
        XCTAssertEqual(s.lines[1], "Lid closed OK · Low Power Mode on · Battery at 38%")
    }

    func testStartingAndGettingReady() throws {
        let s = try XCTUnwrap(strip(awake: .init(until: nil, lid: "starting", pending: true)))
        XCTAssertEqual(s.lines, ["Starting…", "Getting ready for a closed lid"])
    }

    func testOffIsHiddenWhenNothingNotable() {
        XCTAssertNil(strip(power: battery))
        XCTAssertNil(strip(awake: .init(until: nil), offered: false))
    }

    func testOffWithLidClosedSleepProblemAndEnd() throws {
        XCTAssertEqual(strip(power: .init(percent: 50, onBattery: true, watts: nil, lidClosed: true))?.lines, ["Lid closed · Sleeps as usual"])
        let p = try XCTUnwrap(strip(sleepProblem: "Another app turned sleep off."))
        XCTAssertEqual(p.tone, .failed)
        let end = PhoneSnapshot.AwakeEnd(reason: "battery", at: ISO8601DateFormatter().string(from: now), why: "Battery at 9%")
        XCTAssertTrue(try XCTUnwrap(strip(lastEnd: end)).lines[0].contains("battery ran low"))
    }

    func testNotAnsweringReplacesStaleAwakeAndBattery() throws {
        let s = try XCTUnwrap(strip(awake: .init(until: now.addingTimeInterval(3600), lid: "on"), power: battery,
                                    liveness: .silent(since: now.addingTimeInterval(-37 * 60))))
        XCTAssertEqual(s.tone, .silent)
        XCTAssertEqual(s.lines[0], "Mac offline · last heard 37m ago")
        XCTAssertFalse(s.spoken.contains("battery"))
    }

    func testAnOfflineMacInAnAwakeSessionSaysToOpenPersonalHotspot() throws {
        let silent = MacLiveness.silent(since: now.addingTimeInterval(-3 * 60))
        let awake = MacStrip.Awake(until: now.addingTimeInterval(3600), lid: "on")
        let ready = PhoneSnapshot.Hotspot(configured: true, ssid: "Phone", enabled: true, onHotspot: false)
        let s = try XCTUnwrap(MacStrip.compose(awake: awake, power: battery, liveness: silent, hotspot: ready, now: now))
        XCTAssertEqual(s.tone, .silent)
        XCTAssertEqual(s.lines[0], "Mac offline · last heard 3m ago")
        XCTAssertTrue(s.lines[1].hasPrefix("Open Settings › Personal Hotspot on this iPhone"))
        // Already on the hotspot: the hotspot is what to check.
        let on = PhoneSnapshot.Hotspot(configured: true, ssid: "Phone", enabled: true, onHotspot: true)
        XCTAssertTrue(try XCTUnwrap(MacStrip.compose(awake: awake, power: nil, liveness: silent, hotspot: on, now: now))
            .lines[1].contains("still on"))
        // No hotspot set up: say where to set one up.
        XCTAssertTrue(try XCTUnwrap(MacStrip.compose(awake: awake, power: nil, liveness: silent, hotspot: nil, now: now))
            .lines[1].contains("Squeak's Settings"))
        // No awake session: an asleep Mac is the usual reason, so no advice.
        XCTAssertEqual(try XCTUnwrap(MacStrip.compose(awake: nil, power: nil, liveness: silent, hotspot: ready, now: now)).lines,
                       ["Mac not answering", "Last heard 3m ago"])
    }
}

final class MacControlsFormatTests: XCTestCase {
    func testFanWords() {
        XCTAssertEqual(MacControlsFormat.fanSpeed([2300, 2512]), "2,512 rpm")
        XCTAssertEqual(MacControlsFormat.fanSpeed([0, 0]), "Off")
        XCTAssertNil(MacControlsFormat.fanSpeed([]))
        typealias Fans = PhoneSnapshot.MacControls.Fans
        XCTAssertTrue(MacControlsFormat.fanNote(Fans(mode: "auto", choice: "auto", available: false, rpm: []))!.contains("Set up fan control"))
        XCTAssertTrue(MacControlsFormat.fanNote(Fans(mode: "max", choice: "40", available: true, rpm: []))!.contains("while your Mac is warm"))
        XCTAssertNil(MacControlsFormat.fanNote(Fans(mode: "60", choice: "60", available: true, rpm: [])))
    }

    func testTheCommandCarriesExactlyOneControl() throws {
        let json = String(decoding: try JSONEncoder().encode(ControlsCommand.Change.fans("60")), as: UTF8.self)
        XCTAssertEqual(json, #"{"fans":"60"}"#)
        XCTAssertEqual(ControlsCommand.Change.volume(140).volume, 100)
        XCTAssertEqual(String(decoding: try JSONEncoder().encode(ControlsCommand.Change.displaySleep), as: UTF8.self), #"{"displaySleep":true}"#)
        XCTAssertEqual(String(decoding: try JSONEncoder().encode(ControlsCommand.Change.open("com.apple.Notes")), as: UTF8.self), #"{"open":"com.apple.Notes"}"#)
        XCTAssertEqual(String(decoding: try JSONEncoder().encode(ControlsCommand.Change.space("left")), as: UTF8.self), #"{"space":"left"}"#)
        let result = try JSONDecoder().decode(CommandResult.self, from: Data(#"{"status":"sent","apps":[{"id":"com.apple.Notes","name":"Notes"}]}"#.utf8))
        XCTAssertEqual(result.apps, [.init(id: "com.apple.Notes", name: "Notes")])
    }
}
