import Foundation
import XCTest
@testable import SqueakCore

final class AwakeCommandTests: XCTestCase {
    let key = Data(repeating: 7, count: 32).base64EncodedString()

    func testAFlipCarriesTheShapeTheMacReads() throws {
        let pairing = PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Mac")
        let channel = Channel(pairing: pairing, deviceId: "phone-1", transport: FakeTransport())
        let (_, document) = try channel.awakeDocument(on: true, signer: SoftwareSigner())
        XCTAssertEqual(document.device, "phone-1")
        XCTAssertNotNil(document.sig)
        let command = try ChannelCrypto.open(AwakeCommand.self, box: document.box, key: key)
        XCTAssertEqual(command.v, 1)
        XCTAssertEqual(command.kind, "awake")
        XCTAssertTrue(command.on)
        XCTAssertNil(command.minutes)
        XCTAssertGreaterThanOrEqual(command.nonce.count, 16)
        // An untimed start carries only `on`: the shape the first Macs read.
        let json = try ChannelCrypto.open([String: AnyJSONValue].self, box: document.box, key: key)
        XCTAssertEqual(Set(json.keys), ["v", "kind", "on", "nonce", "expiresAt"])
    }

    func testATimedStartAndAnExtensionCarryTheirMinutes() throws {
        let pairing = PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Mac")
        let channel = Channel(pairing: pairing, deviceId: "phone-1", transport: FakeTransport())
        let timed = try ChannelCrypto.open(
            AwakeCommand.self, box: channel.awakeDocument(on: true, minutes: 120, signer: SoftwareSigner()).document.box, key: key)
        XCTAssertEqual(timed.minutes, 120)
        XCTAssertNil(timed.extend)
        let more = try ChannelCrypto.open(
            AwakeCommand.self, box: channel.awakeDocument(on: true, extend: 60, signer: SoftwareSigner()).document.box, key: key)
        XCTAssertEqual(more.extend, 60)
        XCTAssertNil(more.minutes)
    }

    func testTheSwitchIsOptionalInTheSnapshot() throws {
        let base = #"{"v":1,"mac":"Mac","generatedAt":"2026-10-19T00:00:00Z","duck":{"blockedCount":0,"workingCount":0},"sessions":[]"#
        let older = try JSONDecoder().decode(PhoneSnapshot.self, from: Data((base + "}").utf8))
        XCTAssertNil(older.keepAwake)
        let newer = try JSONDecoder().decode(PhoneSnapshot.self, from: Data((base + #","keepAwake":true}"#).utf8))
        XCTAssertEqual(newer.keepAwake, true)
        XCTAssertNil(newer.awakeUntil)
        let timed = try JSONDecoder().decode(
            PhoneSnapshot.self, from: Data((base + #","keepAwake":true,"awakeUntil":"2026-10-19T11:00:00.000Z"}"#).utf8))
        XCTAssertEqual(timed.awakeUntil, "2026-10-19T11:00:00.000Z")
    }
}

final class LidActionsTests: XCTestCase {
    let key = Data(repeating: 7, count: 32).base64EncodedString()
    private let base = #"{"v":1,"mac":"Mac","generatedAt":"2026-10-19T00:00:00Z","duck":{"blockedCount":0,"workingCount":0},"sessions":[]"#

    func testACommandCarriesOnlyTheSwitchesChanged() throws {
        let pairing = PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Mac")
        let channel = Channel(pairing: pairing, deviceId: "phone-1", transport: FakeTransport())
        let (_, document) = try channel.lidActionsDocument(.init(mute: false), signer: SoftwareSigner())
        XCTAssertEqual(document.device, "phone-1")
        XCTAssertNotNil(document.sig)
        let command = try ChannelCrypto.open(LidActionsCommand.self, box: document.box, key: key)
        XCTAssertEqual(command.v, 1)
        XCTAssertEqual(command.kind, "lidActions")
        XCTAssertEqual(command.settings, .init(mute: false))
        XCTAssertGreaterThanOrEqual(command.nonce.count, 16)
        // The Mac's strict reader sees exactly one known key, a boolean.
        struct Raw: Codable { let settings: [String: Bool] }
        XCTAssertEqual(try ChannelCrypto.open(Raw.self, box: document.box, key: key).settings, ["mute": false])
    }

    func testTheFieldsAreOptionalInTheSnapshot() throws {
        let older = try JSONDecoder().decode(PhoneSnapshot.self, from: Data((base + "}").utf8))
        XCTAssertNil(older.awakeLidActions)
        XCTAssertNil(older.awakeRules)
        XCTAssertNil(older.awakeLastEnd)
        XCTAssertNil(older.awakeSleepProblem)
        let json = base + #","keepAwake":false,"awakeLidActions":{"displayOff":true,"mute":false,"lowPower":true,"freezeApps":true},"awakeRules":{"lowPowerPercent":35,"endPercent":8,"heat":true},"awakeLastEnd":{"reason":"battery","at":"2026-10-23T01:00:00.000Z","why":"Battery at 8%"},"awakeSleepProblem":"Sleep is disabled."}"#
        let newer = try JSONDecoder().decode(PhoneSnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(newer.awakeLidActions, .init(displayOff: true, mute: false, lowPower: true, freezeApps: true))
        XCTAssertEqual(newer.awakeLidActions?["freezeApps"], true)
        XCTAssertEqual(newer.awakeRules, .init(lowPowerPercent: 35, endPercent: 8, heat: true))
        XCTAssertEqual(newer.awakeLastEnd?.reason, "battery")
        XCTAssertEqual(newer.awakeSleepProblem, "Sleep is disabled.")
    }

    func testTheSafetyWordsUseTheMacsNumbersAndFallBackToFortyAndTen() {
        XCTAssertEqual(
            AwakeFormat.safetySentence(.init(lowPowerPercent: 35, endPercent: 8, heat: true)),
            "Low Power Mode comes on at 35% battery or when your Mac runs hot, and the session ends by itself at 8% or when it gets very hot.")
        XCTAssertTrue(AwakeFormat.safetySentence(nil).contains("at 40% battery"))
        XCTAssertTrue(AwakeFormat.safetySentence(nil).contains("at 10% or"))
        XCTAssertFalse(AwakeFormat.safetySentence(.init(lowPowerPercent: 30, endPercent: 5, heat: false)).contains("hot"))
    }

    func testOnlyASafetyEndIsSaid() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let at = ISO8601DateFormatter().string(from: now)
        XCTAssertNil(AwakeFormat.ended(.init(reason: "expired", at: at), now: now))
        XCTAssertEqual(AwakeFormat.ended(.init(reason: "battery", at: at, why: "Battery at 9%"), now: now),
                       "The last session ended because the battery ran low (Battery at 9%).")
        XCTAssertNil(AwakeFormat.ended(.init(reason: "heat", at: ISO8601DateFormatter().string(from: now.addingTimeInterval(-7 * 3600))), now: now))
        XCTAssertNil(AwakeFormat.ended(nil))
    }

    func testTheFourSwitchesAndTheirWords() {
        XCTAssertEqual(AwakeFormat.lidActionInfos.map(\.key), ["displayOff", "mute", "lowPower", "freezeApps"])
        var actions = PhoneSnapshot.LidActions()
        actions["mute"] = false
        XCTAssertFalse(actions.mute)
    }
}

/// Any JSON value, just to read a document's top-level keys.
private struct AnyJSONValue: Codable {
    init(from decoder: Decoder) throws { _ = try? decoder.singleValueContainer() }
    func encode(to encoder: Encoder) throws {}
}

final class MacPowerTests: XCTestCase {
    func testThePowerFieldIsOptionalAndReadsNulls() throws {
        let base = #"{"v":1,"mac":"Mac","generatedAt":"2026-10-19T00:00:00Z","duck":{"blockedCount":0,"workingCount":0},"sessions":[]"#
        XCTAssertNil(try JSONDecoder().decode(PhoneSnapshot.self, from: Data((base + "}").utf8)).macPower)
        let snapshot = try JSONDecoder().decode(
            PhoneSnapshot.self,
            from: Data((base + #","macPower":{"percent":50,"onBattery":false,"watts":null,"lidClosed":true}}"#).utf8))
        XCTAssertEqual(snapshot.macPower, .init(percent: 50, onBattery: false, watts: nil, lidClosed: true))
    }
}
