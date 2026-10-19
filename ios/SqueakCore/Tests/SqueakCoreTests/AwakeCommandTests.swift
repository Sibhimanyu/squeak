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

/// Any JSON value, just to read a document's top-level keys.
private struct AnyJSONValue: Codable {
    init(from decoder: Decoder) throws { _ = try? decoder.singleValueContainer() }
    func encode(to encoder: Encoder) throws {}
}
