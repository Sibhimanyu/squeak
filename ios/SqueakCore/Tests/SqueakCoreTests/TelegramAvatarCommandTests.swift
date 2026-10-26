import Foundation
import XCTest
@testable import SqueakCore

/// Pins the `telegramAvatar` view flag and command to docs/remote-channel.md, "Telegram avatar".
final class TelegramAvatarCommandTests: XCTestCase {
    let key = Data(repeating: 7, count: 32).base64EncodedString()

    private indirect enum J: Codable, Equatable {
        case string(String), int(Int64)
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let v = try? c.decode(Int64.self) { self = .int(v) } else { self = .string(try c.decode(String.self)) }
        }
        func encode(to encoder: Encoder) throws { fatalError() }
    }

    func testEnvelopeHasExactlyTheKeysTheMacReads() throws {
        let pairing = PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Mac")
        let ch = Channel(pairing: pairing, deviceId: "phone-1", transport: FakeTransport())
        let (_, doc) = try ch.telegramAvatarDocument(signer: SoftwareSigner())
        XCTAssertNotNil(doc.sig)
        let json = try ChannelCrypto.open([String: J].self, box: doc.box, key: key)
        XCTAssertEqual(Set(json.keys), ["v", "kind", "nonce", "expiresAt"])
        XCTAssertEqual(json["kind"], .string("telegramAvatar"))
        XCTAssertEqual(json["v"], .int(1))
    }

    func testViewDecodesWithAndWithoutTheFlag() throws {
        let base = try JSONEncoder().encode(PhoneSnapshot(v: 1, mac: "m", generatedAt: "", duck: .init(blockedCount: 0, workingCount: 0), sessions: [], recent: []))
        var obj = try JSONSerialization.jsonObject(with: base) as! [String: Any]
        obj.removeValue(forKey: "telegramAvatar")
        let without = try JSONDecoder().decode(PhoneSnapshot.self, from: JSONSerialization.data(withJSONObject: obj))
        XCTAssertNil(without.telegramAvatar)
        obj["telegramAvatar"] = true
        let with = try JSONDecoder().decode(PhoneSnapshot.self, from: JSONSerialization.data(withJSONObject: obj))
        XCTAssertEqual(with.telegramAvatar, true)
    }

    func testResultMapping() throws {
        let sent = try JSONDecoder().decode(CommandResult.self, from: Data(#"{"id":"a","status":"sent"}"#.utf8))
        XCTAssertEqual(TelegramAvatarFormat.line(for: sent), TelegramAvatarFormat.done)
        let refused = try JSONDecoder().decode(
            CommandResult.self, from: Data(#"{"id":"a","status":"refused","reason":"Try again in a minute"}"#.utf8))
        XCTAssertEqual(TelegramAvatarFormat.line(for: refused), "Try again in a minute")
        let bare = try JSONDecoder().decode(CommandResult.self, from: Data(#"{"id":"a","status":"refused"}"#.utf8))
        XCTAssertEqual(TelegramAvatarFormat.line(for: bare), TelegramAvatarFormat.fallbackRefusal)
    }
}
