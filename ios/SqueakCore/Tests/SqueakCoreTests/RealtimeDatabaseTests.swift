import Foundation
import XCTest
@testable import SqueakCore

/// Lines from a table, one stream per connection, then nothing (as if the server held it open).
final class FakeLines: LineStreamTransport, @unchecked Sendable {
    var connections: [[String]]
    var requests: [URLRequest] = []

    init(_ connections: [[String]]) { self.connections = connections }

    func lines(for request: URLRequest) async throws -> AsyncThrowingStream<String, Error> {
        requests.append(request)
        let lines = connections.isEmpty ? nil : connections.removeFirst()
        return AsyncThrowingStream { continuation in
            guard let lines else { return } // held open until cancelled
            for line in lines { continuation.yield(line) }
            continuation.finish()
        }
    }
}

final class RealtimeDatabaseTests: XCTestCase {
    let key = Data(repeating: 7, count: 32).base64EncodedString()
    let db = "https://squeak-test-default-rtdb.asia-southeast1.firebasedatabase.app"

    func testDocumentsAreAddressedAsJSONUnderTheRoot() async throws {
        let transport = FakeTransport()
        transport.responses["GET /channels/c/state/snapshot.json"] = (200, Data(#"{"box":"b","at":5}"#.utf8))
        let client = RealtimeDatabaseClient(databaseURL: db + "/", transport: transport)
        let document = try await client.get("channels/c/state/snapshot")
        XCTAssertEqual(document, ChannelDocument(box: "b", at: 5))
        XCTAssertEqual(transport.requests.first?.url?.absoluteString, db + "/channels/c/state/snapshot.json")
    }

    func testAMissingDocumentIsNil() async throws {
        let transport = FakeTransport()
        transport.responses["GET /channels/c/state/snapshot.json"] = (200, Data("null".utf8))
        let document = try await RealtimeDatabaseClient(databaseURL: db, transport: transport).get("channels/c/state/snapshot")
        XCTAssertNil(document)
    }

    func testWritesPutOnlyTheChannelFields() async throws {
        let transport = FakeTransport()
        try await RealtimeDatabaseClient(databaseURL: db, transport: transport)
            .set("channels/c/commands/x", ChannelDocument(box: "b", sig: "s", device: "d"))
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(request.url?.query, "print=silent")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.httpBody!) as? [String: String])
        XCTAssertEqual(body, ["box": "b", "sig": "s", "device": "d"])
    }

    func testKeepsTheEmulatorNamespaceOnEveryRequest() {
        let client = RealtimeDatabaseClient(databaseURL: "http://127.0.0.1:9000?ns=demo-squeak-default-rtdb")
        XCTAssertEqual(client.url("channels/c/commands/x", silent: true).absoluteString,
                       "http://127.0.0.1:9000/channels/c/commands/x.json?ns=demo-squeak-default-rtdb&print=silent")
    }

    func testChangesYieldPerPutAndPatchAndIgnoreKeepAlives() async throws {
        let lines = FakeLines([[
            "event: put", #"data: {"path":"/","data":null}"#,
            "event: keep-alive", "data: null",
            "event: patch", #"data: {"path":"/x","data":{"box":"b"}}"#,
        ]])
        let client = RealtimeDatabaseClient(databaseURL: db, streams: lines)
        let stream = try XCTUnwrap(client.changes("channels/c/results"))
        var count = 0
        for await _ in stream {
            count += 1
            if count == 2 { break }
        }
        XCTAssertEqual(count, 2)
        XCTAssertEqual(lines.requests.first?.value(forHTTPHeaderField: "accept"), "text/event-stream")
    }

    func testFirestoreCannotStream() {
        XCTAssertNil(FirestoreClient(projectId: "p").changes("x"))
    }

    func testOnlyARealtimeDatabaseHostIsAccepted() {
        XCTAssertTrue(Channel.isDatabaseURL(db))
        XCTAssertTrue(Channel.isDatabaseURL("https://squeak-5c9gvo-default-rtdb.firebaseio.com"))
        XCTAssertFalse(Channel.isDatabaseURL("http://squeak-test-default-rtdb.asia-southeast1.firebasedatabase.app"))
        XCTAssertFalse(Channel.isDatabaseURL("https://evil.example.com/firebasedatabase.app"))
        XCTAssertFalse(Channel.isDatabaseURL("https://firebasedatabase.app.evil.com"))
        XCTAssertFalse(Channel.isDatabaseURL(db + "?ns=other"))
    }

    func testAPairingCodeNamingTheDatabaseUsesItDirectly() async throws {
        let transport = FakeTransport()
        let pairing = PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Mac", r: db)
        let channel = Channel(pairing: pairing, deviceId: "phone", transport: transport)
        try await channel.touchPresence()
        let streams = await channel.streams
        XCTAssertTrue(streams)
        XCTAssertEqual(transport.requests.map { $0.url!.host! }, ["squeak-test-default-rtdb.asia-southeast1.firebasedatabase.app"])
    }

    func testAPhonePairedBeforeTheMoveFollowsTheSealedAnnouncement() async throws {
        let transport = FakeTransport()
        struct Transport: Codable { let r: String }
        let box = try ChannelCrypto.seal(Transport(r: db), key: key)
        transport.responses["GET /v1/projects/p/databases/(default)/documents/channels/AAAAAAAAAAAAAAAAAAAAAA/state/transport"] =
            (200, try JSONSerialization.data(withJSONObject: ChannelDocument(box: box).encoded()))
        let pairing = PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Mac")
        let channel = Channel(pairing: pairing, deviceId: "phone", transport: transport)
        try await channel.touchPresence()
        let last = try XCTUnwrap(transport.requests.last)
        XCTAssertEqual(last.httpMethod, "PUT")
        XCTAssertEqual(last.url?.path, "/channels/AAAAAAAAAAAAAAAAAAAAAA/state/presence.json")
    }

    func testAnAnnouncementSealedWithAnotherKeyIsIgnored() async throws {
        let transport = FakeTransport()
        struct Transport: Codable { let r: String }
        let box = try ChannelCrypto.seal(Transport(r: db), key: Data(repeating: 9, count: 32).base64EncodedString())
        transport.responses["GET /v1/projects/p/databases/(default)/documents/channels/AAAAAAAAAAAAAAAAAAAAAA/state/transport"] =
            (200, try JSONSerialization.data(withJSONObject: ChannelDocument(box: box).encoded()))
        let pairing = PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Mac")
        let channel = Channel(pairing: pairing, deviceId: "phone", transport: transport)
        try await channel.touchPresence()
        XCTAssertEqual(transport.requests.last?.httpMethod, "PATCH") // still Firestore
    }

    func testAPairingCodeAimingAtAnotherHostIsRefused() throws {
        let json = #"{"v":1,"p":"p","c":"AAAAAAAAAAAAAAAAAAAAAA","k":"\#(key)","n":"Mac","r":"https://evil.example.com"}"#
        let code = "squeak://pair?d=" + Data(json.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        XCTAssertThrowsError(try PairingPayload.parse(code))
    }
}
