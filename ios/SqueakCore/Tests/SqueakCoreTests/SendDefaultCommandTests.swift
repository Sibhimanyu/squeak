import Foundation
import XCTest
@testable import SqueakCore

/// Pins the `sendDefault` command and view field to docs/remote-channel.md, "Faster queue, and the send default".
final class SendDefaultCommandTests: XCTestCase {
    let key = Data(repeating: 7, count: 32).base64EncodedString()

    private func channel() -> Channel {
        let pairing = PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Mac")
        return Channel(pairing: pairing, deviceId: "phone-1", transport: FakeTransport())
    }

    private struct Anyish: Decodable {
        let value: Any
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let v = try? c.decode(Int64.self) { value = Int(v) }
            else if let v = try? c.decode(String.self) { value = v }
            else if c.decodeNil() { value = NSNull() }
            else { value = true }
        }
    }

    private func open(_ document: ChannelDocument) throws -> [String: Any] {
        try ChannelCrypto.open([String: Anyish].self, box: document.box, key: key).mapValues(\.value)
    }

    func testCommandHasExactlyTheKeysTheMacReads() throws {
        for mode in [ReplyMode.queue, .steer] {
            let (_, doc) = try channel().sendDefaultDocument(mode: mode, signer: SoftwareSigner())
            XCTAssertNotNil(doc.sig)
            let json = try open(doc)
            XCTAssertEqual(Set(json.keys), ["v", "kind", "mode", "nonce", "expiresAt"])
            XCTAssertEqual(json["kind"] as? String, "sendDefault")
            XCTAssertEqual(json["mode"] as? String, mode.rawValue)
            XCTAssertEqual(json["v"] as? Int, 1)
        }
    }

    func testViewDecodesSendDefaultOptionally() throws {
        XCTAssertNil(try JSONDecoder().decode(Probe.self, from: Data("{}".utf8)).sendDefault)
        XCTAssertEqual(try JSONDecoder().decode(Probe.self, from: Data(#"{"sendDefault":"steer"}"#.utf8)).sendDefault, .steer)
    }

    private struct Probe: Decodable { var sendDefault: ReplyMode? }

    func testAReplyNamesItsModeWhenAskedTo() throws {
        let session = PhoneSnapshot.Session(
            key: "k", conductorSessionId: "s1", label: "l", agent: "claude", state: "working",
            lastActivityAt: "", detail: nil, git: nil, contextPercent: nil, turnId: "t1", message: nil, choices: nil)
        let ch = channel()
        let explicit = try ch.replyDocument(to: session, text: "x", mode: .queue, explicitMode: true, signer: SoftwareSigner())
        XCTAssertEqual(try open(explicit.document)["mode"] as? String, "queue")
        let plain = try ch.replyDocument(to: session, text: "x", mode: .queue, signer: SoftwareSigner())
        XCTAssertNil(try open(plain.document)["mode"])
    }
}
