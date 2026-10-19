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
        let queuedBox: String
        let steeredBox: String
        let steerFallbackBox: String
        let startedBox: String
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

    func testDecodesAWorkingSessionsActivityAndNoneForAFinishedOne() throws {
        let f = try fixture()
        let key = try PairingPayload.parse(f.pairingURL).k
        let snapshot = try ChannelCrypto.open(PhoneSnapshot.self, box: f.snapshotBox, key: key)
        XCTAssertNil(snapshot.sessions.first?.activity)
        let working = try XCTUnwrap(snapshot.sessions.first { $0.state == "working" })
        let activity = try XCTUnwrap(working.activity)
        XCTAssertEqual(activity.total, 9)
        XCTAssertEqual(activity.steps.map(\.kind), ["thinking", "note", "tool", "background"])
        XCTAssertEqual(activity.steps[2].text, "Edit timer.ts")
    }

    func testStillDecodesASnapshotFromAMacThatSendsNoActivity() throws {
        // A phone updated before its Mac must keep working.
        let json = #"{"v":1,"mac":"M","generatedAt":"x","duck":{"blockedCount":0,"workingCount":1},"sessions":[{"key":"k","conductorSessionId":null,"label":"l","agent":"claude","state":"working","lastActivityAt":"x","detail":null,"git":null,"contextPercent":null,"turnId":null,"message":null,"choices":null}]}"#
        let snapshot = try JSONDecoder().decode(PhoneSnapshot.self, from: Data(json.utf8))
        XCTAssertNil(snapshot.sessions.first?.activity)
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

    func testDecodesTheMacsUsageReadings() throws {
        let f = try fixture()
        let key = try PairingPayload.parse(f.pairingURL).k
        let usage = try XCTUnwrap(try ChannelCrypto.open(PhoneSnapshot.self, box: f.snapshotBox, key: key).usage)
        XCTAssertEqual(usage.claude?.fiveHour?.usedPercent, 42)
        XCTAssertEqual(usage.claude?.sevenDay?.usedPercent, 18)
        XCTAssertEqual(usage.claude?.observedAt, "2026-09-25T00:00:00.000Z")
        XCTAssertEqual(usage.codex?.fiveHour?.usedPercent, 9)
        XCTAssertEqual(usage.codex?.weekly?.usedPercent, 31.4)
        XCTAssertEqual(usage.codex?.weekly?.resetsAt, "2026-09-30T03:00:00.000Z")
    }

    func testStillDecodesASnapshotWithoutUsage() throws {
        let json = #"{"v":1,"mac":"M","generatedAt":"x","duck":{"blockedCount":0,"workingCount":0},"sessions":[]}"#
        XCTAssertNil(try JSONDecoder().decode(PhoneSnapshot.self, from: Data(json.utf8)).usage)
    }

    func testDecodesHowAMessageWasDelivered() throws {
        let f = try fixture()
        let key = try PairingPayload.parse(f.pairingURL).k
        XCTAssertEqual(try ChannelCrypto.open(CommandResult.self, box: f.queuedBox, key: key).delivery, "queued")
        XCTAssertEqual(try ChannelCrypto.open(CommandResult.self, box: f.steeredBox, key: key).delivery, "steered")
        let fallback = try ChannelCrypto.open(CommandResult.self, box: f.steerFallbackBox, key: key)
        XCTAssertEqual(fallback.delivery, "queued")
        XCTAssertNotNil(fallback.note)
        // An older Mac says nothing about delivery.
        XCTAssertNil(try ChannelCrypto.open(CommandResult.self, box: f.resultBox, key: key).delivery)
    }

    func testDecodesTheWorkspacesTheMacOffersAndTheStartedChat() throws {
        let f = try fixture()
        let key = try PairingPayload.parse(f.pairingURL).k
        let snapshot = try ChannelCrypto.open(PhoneSnapshot.self, box: f.snapshotBox, key: key)
        let workspaces = try XCTUnwrap(snapshot.workspaces)
        XCTAssertEqual(workspaces.map(\.label), ["farm · arm", "farm · timer"])
        XCTAssertEqual(workspaces.map(\.agent), [.claude, .codex])
        let started = try ChannelCrypto.open(CommandResult.self, box: f.startedBox, key: key)
        XCTAssertTrue(started.sent)
        XCTAssertEqual(started.sessionId, "new-1")
    }

    func testStillDecodesASnapshotFromAMacThatCannotStartChats() throws {
        let json = #"{"v":1,"mac":"M","generatedAt":"x","duck":{"blockedCount":0,"workingCount":0},"sessions":[]}"#
        XCTAssertNil(try JSONDecoder().decode(PhoneSnapshot.self, from: Data(json.utf8)).workspaces)
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

        // A phone paired before the move first asks where the channel lives; this one hears "Firestore".
        let request = try XCTUnwrap(transport.requests.first { $0.httpMethod == "PATCH" })
        XCTAssertTrue(request.url!.path.hasSuffix("/channels/AAAAAAAAAAAAAAAAAAAAAA/commands/\(id)"))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.httpBody!) as? [String: Any])
        let fields = try XCTUnwrap(body["fields"] as? [String: Any])
        XCTAssertEqual(Set(fields.keys), ["box", "sig", "device"])
        let command = try ChannelCrypto.open(ReplyCommand.self, box: document.box, key: pairing.k)
        XCTAssertEqual(command.text, "A")
        XCTAssertEqual(command.answersTurn, "t1")
        XCTAssertEqual(command.nonce.count, 32)
        // A queued reply carries no mode at all, so it is byte-identical to before the field existed.
        XCTAssertNil(command.mode)
    }

    func testASteeredReplySignsItsModeIn() throws {
        let pairing = PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: Data(repeating: 7, count: 32).base64EncodedString(), n: "Mac")
        let channel = Channel(pairing: pairing, deviceId: "phone-1", transport: FakeTransport())
        let session = PhoneSnapshot.Session(
            key: "k", conductorSessionId: "s1", label: "l", agent: "claude", state: "working",
            lastActivityAt: "", detail: nil, git: nil, contextPercent: nil, turnId: "t1", message: nil, choices: nil
        )
        let (_, document) = try channel.replyDocument(to: session, text: "A", mode: .steer, signer: SoftwareSigner())
        XCTAssertEqual(try ChannelCrypto.open(ReplyCommand.self, box: document.box, key: pairing.k).mode, .steer)
    }

    func testAStartCommandCarriesNoSessionAndSignsItsKind() throws {
        let pairing = PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: Data(repeating: 7, count: 32).base64EncodedString(), n: "Mac")
        let channel = Channel(pairing: pairing, deviceId: "phone-1", transport: FakeTransport())
        let now = Date()
        let (_, document) = try channel.startDocument(workspaceId: "w1", agent: .claude, text: "Hi", signer: SoftwareSigner(), now: now)
        XCTAssertNotNil(document.sig)
        XCTAssertEqual(document.device, "phone-1")
        let command = try ChannelCrypto.open(StartCommand.self, box: document.box, key: pairing.k)
        XCTAssertEqual(command.kind, "start")
        XCTAssertEqual(command.workspaceId, "w1")
        XCTAssertEqual(command.agent, .claude)
        XCTAssertEqual(command.nonce.count, 32)
        XCTAssertEqual(command.expiresAt, Int64((now.timeIntervalSince1970 + Channel.commandLifetime) * 1000))
        // Sealed as a plain object: no sessionId or answersTurn key for a reply path to misread.
        struct Keys: Decodable {
            struct Key: CodingKey {
                var stringValue: String
                var intValue: Int? { nil }
                init?(stringValue: String) { self.stringValue = stringValue }
                init?(intValue: Int) { nil }
            }
            let names: Set<String>
            init(from decoder: Decoder) throws {
                names = Set(try decoder.container(keyedBy: Key.self).allKeys.map(\.stringValue))
            }
        }
        let keys = try ChannelCrypto.open(Keys.self, box: document.box, key: pairing.k)
        XCTAssertEqual(keys.names, ["v", "kind", "workspaceId", "agent", "text", "nonce", "expiresAt"])
    }

    func testAMissingSnapshotIsNilNotAnError() async throws {
        let transport = FakeTransport()
        let pairing = PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: Data(repeating: 1, count: 32).base64EncodedString(), n: "Mac")
        transport.responses["GET /v1/projects/p/databases/(default)/documents/channels/AAAAAAAAAAAAAAAAAAAAAA/state/snapshot"] = (404, Data())
        let snapshot = try await Channel(pairing: pairing, deviceId: "d", transport: transport).snapshot()
        XCTAssertNil(snapshot)
    }
}
