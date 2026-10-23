import CryptoKit
import Foundation
import XCTest
@testable import SqueakCore

/// The direct path's request signing against the fixture the Mac's own code generates
/// (`npx tsx scripts/make-local-fixture.ts`): every derived value must match byte for byte.
final class LocalAuthTests: XCTestCase {
    struct Fixture: Decodable {
        struct Req: Decodable { let method: String; let target: String; let ts: String; let nonce: String; let body: String; let mac: String; let canonical: String? }
        struct Resp: Decodable { let nonce: String; let status: Int; let body: String; let mac: String; let canonical: String? }
        let channelKey: String
        let localKey: String
        let tag: String
        let request: Req
        let response: Resp
        let readRequest: Req
        let readResponse: Resp
    }

    func fixture() throws -> Fixture {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "Fixtures/local-auth", withExtension: "json"))
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    func testDerivesTheMacsKeyAndTag() throws {
        let f = try fixture()
        let key = try XCTUnwrap(LocalAuth.key(channelKey: f.channelKey))
        XCTAssertEqual(key.withUnsafeBytes { Data($0) }.base64EncodedString(), f.localKey)
        XCTAssertEqual(LocalAuth.tag(channelKey: f.channelKey), f.tag)
        // The tag names a channel without being its key, and another channel has another tag.
        XCTAssertNotEqual(LocalAuth.tag(channelKey: Data(repeating: 9, count: 32).base64EncodedString()), f.tag)
        XCTAssertNil(LocalAuth.key(channelKey: "short"))
        XCTAssertNil(LocalAuth.tag(channelKey: Data(repeating: 1, count: 16).base64EncodedString()))
    }

    func testSignsRequestsExactlyAsTheMacVerifiesThem() throws {
        let f = try fixture()
        let key = try XCTUnwrap(LocalAuth.key(channelKey: f.channelKey))
        for request in [f.request, f.readRequest] {
            let body = Data(request.body.utf8)
            XCTAssertEqual(LocalAuth.requestMAC(key: key, method: request.method, target: request.target, timestamp: request.ts, nonce: request.nonce, body: body), request.mac)
        }
        XCTAssertEqual(LocalAuth.requestCanonical(method: "put", target: f.request.target, timestamp: f.request.ts, nonce: f.request.nonce, body: Data(f.request.body.utf8)), f.request.canonical)
    }

    func testChecksTheMacsResponsesAndBindsThemToTheRequest() throws {
        let f = try fixture()
        let key = try XCTUnwrap(LocalAuth.key(channelKey: f.channelKey))
        for (nonce, response) in [(f.request.nonce, f.response), (f.readRequest.nonce, f.readResponse)] {
            let body = Data(response.body.utf8)
            XCTAssertEqual(LocalAuth.responseMAC(key: key, nonce: nonce, status: response.status, body: body), response.mac)
            XCTAssertTrue(LocalAuth.isValidResponse(key: key, nonce: nonce, status: response.status, body: body, mac: response.mac))
            // An answer to another request, another status or another body is refused: no replayed document.
            XCTAssertFalse(LocalAuth.isValidResponse(key: key, nonce: LocalAuth.newNonce(), status: response.status, body: body, mac: response.mac))
            XCTAssertFalse(LocalAuth.isValidResponse(key: key, nonce: nonce, status: response.status + 1, body: body, mac: response.mac))
            XCTAssertFalse(LocalAuth.isValidResponse(key: key, nonce: nonce, status: response.status, body: body + Data("x".utf8), mac: response.mac))
        }
        XCTAssertFalse(LocalAuth.isValidResponse(key: key, nonce: f.request.nonce, status: 204, body: Data(), mac: nil))
        XCTAssertFalse(LocalAuth.isValidResponse(key: key, nonce: f.request.nonce, status: 204, body: Data(), mac: "not base64!"))
    }

    func testNoncesAreFreshAndTheMacsFormat() {
        let a = LocalAuth.newNonce(), b = LocalAuth.newNonce()
        XCTAssertNotEqual(a, b)
        XCTAssertNotNil(a.range(of: "^[0-9a-f]{32}$", options: .regularExpression))
    }
}

final class LocalSignerTests: XCTestCase {
    let channelKey = Data((0..<32).map { UInt8($0) }).base64EncodedString()
    let channelId = "AAAAAAAAAAAAAAAAAAAAAA"

    private func signer(at seconds: TimeInterval = 1_790_000_000) throws -> LocalSigner {
        try LocalSigner(channelKey: channelKey, channelId: channelId, now: { Date(timeIntervalSince1970: seconds) })
    }

    func testRewritesTheDatabasePathToTheMacsAndSignsIt() throws {
        let client = RealtimeDatabaseClient(databaseURL: "http://192.168.1.20:51234")
        var request = URLRequest(url: client.url("channels/\(channelId)/commands/c1", silent: true))
        request.httpMethod = "PUT"
        request.httpBody = Data(#"{"box":"A"}"#.utf8)
        request.timeoutInterval = 15
        let (signed, nonce) = try signer().sign(request, timeout: 3)
        // The channel id never reaches the LAN, and the host is the Mac's.
        XCTAssertEqual(signed.url?.absoluteString, "http://192.168.1.20:51234/commands/c1.json?print=silent")
        XCTAssertFalse(signed.url!.absoluteString.contains(channelId))
        XCTAssertEqual(signed.timeoutInterval, 3)
        XCTAssertEqual(signed.value(forHTTPHeaderField: LocalAuth.headerTimestamp), "1790000000000")
        XCTAssertEqual(signed.value(forHTTPHeaderField: LocalAuth.headerNonce), nonce)
        let key = try XCTUnwrap(LocalAuth.key(channelKey: channelKey))
        XCTAssertEqual(signed.value(forHTTPHeaderField: LocalAuth.headerMAC),
                       LocalAuth.requestMAC(key: key, method: "PUT", target: "/commands/c1.json?print=silent", timestamp: "1790000000000", nonce: nonce, body: Data(#"{"box":"A"}"#.utf8)))
    }

    func testRefusesAPathThatIsNotThisChannels() throws {
        let other = URLRequest(url: URL(string: "http://192.168.1.20:1/channels/OTHER/state/snapshot.json")!)
        XCTAssertThrowsError(try signer().sign(other)) { XCTAssertEqual($0 as? LocalFailure, .badPath) }
        let bare = URLRequest(url: URL(string: "http://192.168.1.20:1/state/snapshot.json")!)
        XCTAssertThrowsError(try signer().sign(bare))
    }

    func testNonOKAnswersAndBadMACsAreFailures() async throws {
        final class Canned: HTTPTransport, @unchecked Sendable {
            var status = 200; var mac: String?; var body = Data("null".utf8); var seen: URLRequest?
            let key: SymmetricKey
            var forgeNonce: String?
            init(key: SymmetricKey) { self.key = key }
            func data(for request: URLRequest) async throws -> (Data, URLResponse) {
                seen = request
                let nonce = forgeNonce ?? request.value(forHTTPHeaderField: LocalAuth.headerNonce)!
                var headers: [String: String] = [:]
                headers[LocalAuth.headerResponseMAC] = mac ?? LocalAuth.responseMAC(key: key, nonce: nonce, status: status, body: body)
                return (body, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!)
            }
        }
        let key = try XCTUnwrap(LocalAuth.key(channelKey: channelKey))
        let inner = Canned(key: key)
        let client = RealtimeDatabaseClient(databaseURL: "http://127.0.0.1:1", transport: LocalHTTPTransport(signer: try signer(), inner: inner))
        let path = "channels/\(channelId)/state/snapshot"
        // The Mac's own answer is believed.
        let document = try await client.get(path)
        XCTAssertNil(document)
        // An answer made for a different request (a stale one replayed) is not.
        inner.forgeNonce = LocalAuth.newNonce()
        do { _ = try await client.get(path); XCTFail("accepted a replayed answer") } catch { XCTAssertEqual(error as? LocalFailure, .badResponseMAC) }
        inner.forgeNonce = nil
        // Nor one with no MAC, or a wrong one, whatever it says.
        inner.mac = "AAAA"
        do { _ = try await client.get(path); XCTFail("accepted a forged answer") } catch { XCTAssertEqual(error as? LocalFailure, .badResponseMAC) }
        inner.mac = nil
        inner.status = 401
        do { _ = try await client.get(path); XCTFail("accepted a refusal") } catch { XCTAssertEqual(error as? RealtimeDatabaseClient.Failure, .http(401)) }
    }

    func testAStreamOpensOnlyWithTheMacsOwnMAC() async throws {
        final class Canned: LocalByteStream, @unchecked Sendable {
            var mac: String?; let key: SymmetricKey; var lines = ["event: put", #"data: {"path":"/","data":"changed"}"#]
            init(key: SymmetricKey) { self.key = key }
            func open(_ request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<String, Error>) {
                let nonce = request.value(forHTTPHeaderField: LocalAuth.headerNonce)!
                let headers = [LocalAuth.headerResponseMAC: mac ?? LocalAuth.responseMAC(key: key, nonce: nonce, status: 200, body: Data())]
                let lines = lines
                return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: headers)!,
                        AsyncThrowingStream { continuation in for line in lines { continuation.yield(line) }; continuation.finish() })
            }
        }
        let key = try XCTUnwrap(LocalAuth.key(channelKey: channelKey))
        let inner = Canned(key: key)
        let stream = LocalLineStream(signer: try signer(), inner: inner)
        let request = URLRequest(url: URL(string: "http://127.0.0.1:1/channels/\(channelId)/state.json")!)
        var received: [String] = []
        for try await line in try await stream.lines(for: request) { received.append(line) }
        XCTAssertEqual(received.count, 2)
        inner.mac = "AAAA"
        do { _ = try await stream.lines(for: request); XCTFail("opened an impostor's stream") } catch { XCTAssertEqual(error as? LocalFailure, .badResponseMAC) }
    }

    func testEventsFromTheMacAlwaysSendTheReaderBackToARead() {
        // What the Mac's local server sends: the event names a path and says "changed", never the data.
        let names = ["snapshot", "alive", "recent"]
        let connect = RealtimeDatabaseClient.childChanges(event: "put", data: #"{"path":"/","data":"changed"}"#, names: names)
        XCTAssertEqual(connect.map(\.0), names)
        XCTAssertTrue(connect.allSatisfy { $0.1 == .refetch })
        let one = RealtimeDatabaseClient.childChanges(event: "put", data: #"{"path":"/snapshot","data":"changed"}"#, names: names)
        XCTAssertEqual(one.map(\.0), ["snapshot"])
        XCTAssertEqual(one.first?.1, .refetch)
        XCTAssertEqual(RealtimeDatabaseClient.change(from: #"{"path":"/","data":"changed"}"#), .refetch)
    }

    func testOnlyAnErrorThatProvesNothingWasSentLetsACommandGoAnotherWay() {
        XCTAssertTrue(LocalFailure.neverReached(URLError(.cannotConnectToHost)))
        XCTAssertTrue(LocalFailure.neverReached(URLError(.notConnectedToInternet)))
        XCTAssertTrue(LocalFailure.neverReached(LocalFailure.badPath))
        XCTAssertFalse(LocalFailure.neverReached(URLError(.timedOut)))
        XCTAssertFalse(LocalFailure.neverReached(URLError(.networkConnectionLost)))
        XCTAssertFalse(LocalFailure.neverReached(LocalFailure.badResponseMAC))
    }
}

final class LocalEndpointHintsTests: XCTestCase {
    func testTakesOnlyPrivateAddressesOfThisChannelsOwnMac() throws {
        let tag = try XCTUnwrap(LocalAuth.tag(channelKey: Data(repeating: 7, count: 32).base64EncodedString()))
        let info = PhoneSnapshot.LocalEndpointInfo(port: 5123, hosts: ["192.168.1.20", "10.0.0.4", "172.20.10.2", "8.8.8.8", "evil.example.com", "192.168.1.20.evil", "172.40.0.1"], tag: tag)
        XCTAssertEqual(LocalEndpointHints.urls(info, expectedTag: tag).map(\.absoluteString),
                       ["http://192.168.1.20:5123", "http://10.0.0.4:5123", "http://172.20.10.2:5123"])
        // Another Mac's tag, a missing view, a nonsense port: nothing to try.
        XCTAssertEqual(LocalEndpointHints.urls(info, expectedTag: "0000000000000000"), [])
        XCTAssertEqual(LocalEndpointHints.urls(nil, expectedTag: tag), [])
        XCTAssertEqual(LocalEndpointHints.urls(PhoneSnapshot.LocalEndpointInfo(port: 0, hosts: ["10.0.0.4"], tag: tag), expectedTag: tag), [])
    }

    func testTheViewCarriesTheEndpointAndOlderViewsDoNot() throws {
        let json = #"{"v":1,"mac":"M","generatedAt":"","duck":{"blockedCount":0,"workingCount":0},"sessions":[],"local":{"port":5123,"hosts":["192.168.1.20"],"tag":"aa85f1343db6bfd6"}}"#
        let view = try JSONDecoder().decode(PhoneSnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(view.local, PhoneSnapshot.LocalEndpointInfo(port: 5123, hosts: ["192.168.1.20"], tag: "aa85f1343db6bfd6"))
        let older = #"{"v":1,"mac":"M","generatedAt":"","duck":{"blockedCount":0,"workingCount":0},"sessions":[]}"#
        XCTAssertNil(try JSONDecoder().decode(PhoneSnapshot.self, from: Data(older.utf8)).local)
    }
}
