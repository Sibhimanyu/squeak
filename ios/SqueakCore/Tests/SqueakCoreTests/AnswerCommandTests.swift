import Foundation
import XCTest
@testable import SqueakCore

final class AnswerCommandTests: XCTestCase {
    let key = Data(repeating: 7, count: 32).base64EncodedString()

    func testAnAnswerCarriesOnlyTheKeysTheMacAccepts() throws {
        let pairing = PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Mac")
        let channel = Channel(pairing: pairing, deviceId: "phone-1", transport: FakeTransport())
        let (_, document) = try channel.answerDocument(
            sessionId: "s1", toolUseId: "toolu_1",
            answers: [.init(question: 0, picked: ["Red"]), .init(question: 1, picked: [], other: "Neither")],
            signer: SoftwareSigner())
        XCTAssertEqual(document.device, "phone-1")
        XCTAssertNotNil(document.sig)
        let json = try ChannelCrypto.open([String: AnyCodable].self, box: document.box, key: key)
        // The Mac refuses anything else (answer-command.ts COMMAND_KEYS).
        XCTAssertEqual(Set(json.keys), ["v", "kind", "sessionId", "toolUseId", "answers", "nonce", "expiresAt"])
        let command = try ChannelCrypto.open(AnswerCommand.self, box: document.box, key: key)
        XCTAssertEqual(command.kind, "answer")
        XCTAssertEqual(command.answers?[0].other, nil)
        XCTAssertEqual(command.answers?[1].other, "Neither")
    }

    /// A plan's answer carries `plan` and no `answers`: the Mac takes exactly one of the two.
    func testAPlanAnswerCarriesOnlyThePlan() throws {
        let pairing = PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Mac")
        let channel = Channel(pairing: pairing, deviceId: "phone-1", transport: FakeTransport())
        let approve = try channel.answerDocument(sessionId: "s1", toolUseId: "toolu_p", answers: nil,
                                                 plan: .init(approve: true), signer: SoftwareSigner()).document
        let json = try ChannelCrypto.open([String: AnyCodable].self, box: approve.box, key: key)
        XCTAssertEqual(Set(json.keys), ["v", "kind", "sessionId", "toolUseId", "plan", "nonce", "expiresAt"])
        XCTAssertEqual(try ChannelCrypto.open(AnswerCommand.self, box: approve.box, key: key).plan, .init(approve: true))
        let change = try channel.answerDocument(sessionId: "s1", toolUseId: "toolu_p", answers: nil,
                                                plan: .init(approve: false, note: "Two retries"), signer: SoftwareSigner()).document
        XCTAssertEqual(try ChannelCrypto.open(AnswerCommand.self, box: change.box, key: key).plan?.note, "Two retries")
    }
}

/// Just enough to read a command's top-level keys.
struct AnyCodable: Codable {
    init(from decoder: Decoder) throws { _ = try? decoder.singleValueContainer() }
    func encode(to encoder: Encoder) throws {}
}
