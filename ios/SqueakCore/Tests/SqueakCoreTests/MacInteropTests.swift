import Foundation
import XCTest
@testable import SqueakCore

/// Everything the Mac makes (src/remote/remote-bridge.ts), decoded by the
/// phone's models. Regenerate the fixture if the Mac's shapes change; a
/// failure here is a phone that would silently show nothing.
final class MacInteropTests: XCTestCase {
    struct Fixture: Decodable {
        let pairingURL: String
        let snapshotBox: String
        let resultBox: String
        let refusedBox: String
        let pairAnswerBox: String
    }

    func fixture() throws -> Fixture {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "mac-made", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    func testParsesTheMacsPairingCode() throws {
        let payload = try PairingPayload.parse(try fixture().pairingURL)
        XCTAssertEqual(payload.p, "squeak-5c9gvo")
        XCTAssertEqual(payload.n, "Test Mac")
        XCTAssertEqual(Data(base64Encoded: payload.k)?.count, 32)
    }

    func testDecodesTheMacsSnapshotIncludingParsedChoices() throws {
        let f = try fixture()
        let payload = try PairingPayload.parse(f.pairingURL)
        let snapshot = try ChannelCrypto.open(PhoneSnapshot.self, box: f.snapshotBox, key: payload.k)
        XCTAssertEqual(snapshot.mac, "Test Mac")
        let session = try XCTUnwrap(snapshot.sessions.first)
        XCTAssertEqual(session.label, "farm · arm")
        XCTAssertEqual(session.turnId, "turn-1")
        XCTAssertEqual(session.stateWord, "done")
        XCTAssertTrue(session.canReply)
        XCTAssertEqual(session.choices?.options.map(\.letter), ["A", "B"])
        XCTAssertEqual(session.choices?.options.first?.title, "Arm it now")
        XCTAssertEqual(session.choices?.recommended, "A")
    }

    func testDecodesResultsAndThePairingAnswer() throws {
        let f = try fixture()
        let key = try PairingPayload.parse(f.pairingURL).k
        XCTAssertTrue(try ChannelCrypto.open(CommandResult.self, box: f.resultBox, key: key).sent)
        let refused = try ChannelCrypto.open(CommandResult.self, box: f.refusedBox, key: key)
        XCTAssertFalse(refused.sent)
        XCTAssertEqual(refused.reason, "That chat has moved on.")
        XCTAssertTrue(try ChannelCrypto.open(PairingAnswer.self, box: f.pairAnswerBox, key: key).approved)
    }

    func testRejectsThingsThatAreNotPairingCodes() {
        XCTAssertThrowsError(try PairingPayload.parse("https://example.com"))
        XCTAssertThrowsError(try PairingPayload.parse("squeak://pair?d=bm90LWpzb24"))
    }
}

/// A transport that records requests and answers from a table.
final class FakeTransport: HTTPTransport, @unchecked Sendable {
    var requests: [URLRequest] = []
    var responses: [String: (Int, Data)] = [:]

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        let key = "\(request.httpMethod ?? "GET") \(request.url!.path)"
        let (status, body) = responses[key] ?? (200, Data("{}".utf8))
        return (body, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

final class ChannelTests: XCTestCase {
    func testSendsASignedReplyInTheShapeTheRulesAllow() async throws {
        let transport = FakeTransport()
        let pairing = PairingPayload(v: 1, p: "squeak-test", c: "AAAAAAAAAAAAAAAAAAAAAA", k: Data(repeating: 7, count: 32).base64EncodedString(), n: "Mac")
        let channel = Channel(pairing: pairing, deviceId: "phone-1", transport: transport)
        let session = PhoneSnapshot.Session(
            key: "k", conductorSessionId: "s1", label: "l", agent: "claude", state: "finished",
            lastActivityAt: "", detail: nil, git: nil, contextPercent: nil, turnId: "t1", message: nil, choices: nil
        )
        let (id, document) = try channel.replyDocument(to: session, text: "A", signer: SoftwareSigner())
        try await channel.send(document, id: id)

        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertTrue(request.url!.path.hasSuffix("/channels/AAAAAAAAAAAAAAAAAAAAAA/commands/\(id)"))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.httpBody!) as? [String: Any])
        let fields = try XCTUnwrap(body["fields"] as? [String: Any])
        XCTAssertEqual(Set(fields.keys), ["box", "sig", "device"])
        let command = try ChannelCrypto.open(ReplyCommand.self, box: document.box, key: pairing.k)
        XCTAssertEqual(command.text, "A")
        XCTAssertEqual(command.answersTurn, "t1")
        XCTAssertEqual(command.nonce.count, 32)
    }

    func testAMissingSnapshotIsNilNotAnError() async throws {
        let transport = FakeTransport()
        let pairing = PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: Data(repeating: 1, count: 32).base64EncodedString(), n: "Mac")
        transport.responses["GET /v1/projects/p/databases/(default)/documents/channels/AAAAAAAAAAAAAAAAAAAAAA/state/snapshot"] = (404, Data())
        let snapshot = try await Channel(pairing: pairing, deviceId: "d", transport: transport).snapshot()
        XCTAssertNil(snapshot)
    }
}
