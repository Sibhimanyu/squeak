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
        XCTAssertGreaterThanOrEqual(command.nonce.count, 16)
    }

    func testTheSwitchIsOptionalInTheSnapshot() throws {
        let base = #"{"v":1,"mac":"Mac","generatedAt":"2026-10-19T00:00:00Z","duck":{"blockedCount":0,"workingCount":0},"sessions":[]"#
        let older = try JSONDecoder().decode(PhoneSnapshot.self, from: Data((base + "}").utf8))
        XCTAssertNil(older.keepAwake)
        let newer = try JSONDecoder().decode(PhoneSnapshot.self, from: Data((base + #","keepAwake":true}"#).utf8))
        XCTAssertEqual(newer.keepAwake, true)
    }
}
