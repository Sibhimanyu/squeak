import Foundation
import XCTest
@testable import SqueakCore

/// Two stores in one fake network: a Realtime Database host (`<path>.json`) and a Catalyst relay (`/doc?path=`).
final class TwoStores: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var docs: [String: [String: [String: Any]]] = [:] // host -> path -> doc
    private var _writes: [String] = []
    var writes: [String] { lock.withLock { _writes } }

    func seed(host: String, path: String, _ doc: [String: Any]) { lock.withLock { docs[host, default: [:]][path] = doc } }
    func has(host: String, path: String) -> Bool { lock.withLock { docs[host]?[path] != nil } }

    private func respond(method: String, host: String, path: String, isRelay: Bool, sent: Data) -> (Int, Data) {
        lock.lock()
        defer { lock.unlock() }
        if method == "PUT" {
            _writes.append("\(host) \(path)")
            var json: [String: Any] = (try? JSONSerialization.jsonObject(with: sent)) as? [String: Any] ?? [:]
            if isRelay { json = (json["doc"] as? [String: Any]) ?? [:] }
            docs[host, default: [:]][path] = json
            return (isRelay ? 204 : 200, Data())
        }
        if method == "DELETE" {
            docs[host]?[path] = nil
            return (200, Data())
        }
        guard let doc = docs[host]?[path] else { return (isRelay ? 404 : 200, Data("null".utf8)) }
        let payload: [String: Any] = isRelay ? ["doc": doc] : doc
        return (200, (try? JSONSerialization.data(withJSONObject: payload)) ?? Data("null".utf8))
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let url = request.url!
        let host = url.host!
        let isRelay = url.path.hasSuffix("/doc")
        let path: String
        if isRelay {
            path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "path" }?.value ?? ""
        } else {
            path = String(url.path.dropFirst().dropLast(5)) // "/<path>.json"
        }
        let method = request.httpMethod ?? "GET"
        let sentBody = request.httpBody ?? Data()
        let (status, body) = respond(method: method, host: host, path: path, isRelay: isRelay, sent: sentBody)
        return (body, HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

final class CloudMoveTests: XCTestCase {
    let key = Data(repeating: 7, count: 32).base64EncodedString()
    let channelId = "AAAAAAAAAAAAAAAAAAAAAA"
    let db = "https://squeak-test-default-rtdb.asia-southeast1.firebasedatabase.app"
    let relay = "https://squeak-1.development.catalystserverless.in/server/squeak_relay"
    let relayKey = "k3y_k3y_k3y_k3y_k3y_k3y_k3y_k3y_k3y_k3y_xx"

    private func code(_ fields: [String: Any]) throws -> String {
        var json: [String: Any] = ["v": 1, "p": "squeak-test", "c": channelId, "k": key, "n": "Mac"]
        for (k, v) in fields { json[k] = v }
        let data = try JSONSerialization.data(withJSONObject: json)
        let encoded = data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        return "squeak://pair?d=" + encoded
    }

    /* ---------- the pairing code ---------- */

    func testAnOldCodeIsStillFirebase() throws {
        let pairing = try PairingPayload.parse(try code(["r": db]))
        XCTAssertEqual(pairing.r, db)
        XCTAssertNil(pairing.cu)
        XCTAssertNil(pairing.ck)
        XCTAssertFalse(pairing.onCatalyst)
        XCTAssertEqual(pairing.c, channelId)
        // A stored pairing from before the fields round-trips without them.
        let stored = try JSONEncoder().encode(pairing)
        XCTAssertFalse(String(decoding: stored, as: UTF8.self).contains("\"cu\""))
        XCTAssertEqual(try JSONDecoder().decode(PairingPayload.self, from: stored), pairing)
    }

    func testANewCodeNamesTheRelayAndItsKey() throws {
        let pairing = try PairingPayload.parse(try code(["cu": relay, "ck": relayKey]))
        XCTAssertTrue(pairing.onCatalyst)
        XCTAssertEqual(pairing.cu, relay)
        XCTAssertEqual(pairing.ck, relayKey)
        XCTAssertEqual(pairing.c, channelId, "the channel id stays `c`")
        XCTAssertEqual(try JSONDecoder().decode(PairingPayload.self, from: JSONEncoder().encode(pairing)), pairing)
        // A Mac with no Firebase project at all.
        let bare = try PairingPayload.parse(try code(["cu": relay, "ck": relayKey, "p": NSNull()]))
        XCTAssertEqual(bare.p, "")
    }

    func testARelayThatIsNotCatalystsOrHasNoKeyIsRefused() throws {
        XCTAssertThrowsError(try PairingPayload.parse(try code(["cu": "https://evil.example.com/server/x", "ck": relayKey])))
        XCTAssertThrowsError(try PairingPayload.parse(try code(["cu": "http://a.catalystserverless.in", "ck": relayKey])))
        XCTAssertThrowsError(try PairingPayload.parse(try code(["cu": relay])))
        XCTAssertThrowsError(try PairingPayload.parse(try code(["ck": relayKey])))
        XCTAssertThrowsError(try PairingPayload.parse(try code(["cu": relay, "ck": "short"])))
        XCTAssertThrowsError(try PairingPayload.parse(try code(["cu": relay, "ck": "has space and!!! bad chars in the key..."])))
    }

    func testACatalystPairingUsesTheRelayAndStaysOffFirestore() async throws {
        let stores = TwoStores()
        let pairing = try PairingPayload.parse(try code(["cu": relay, "ck": relayKey]))
        let channel = Channel(pairing: pairing, deviceId: "phone", transport: stores, streams: FakeLines([]), sockets: FakeSockets())
        try await channel.touchPresence()
        XCTAssertEqual(stores.writes, ["squeak-1.development.catalystserverless.in channels/\(channelId)/state/presence"])
    }

    /* ---------- the move ---------- */

    private func sealed(_ move: CloudMove, key: String? = nil) throws -> [String: Any] {
        ["box": try ChannelCrypto.seal(move, key: key ?? self.key), "at": 1]
    }

    func testAMoveSwitchesTheStoreAndPresenceLandsThere() async throws {
        let stores = TwoStores()
        let dbHost = URL(string: db)!.host!
        let relayHost = URL(string: relay)!.host!
        let old = try PairingPayload.parse(try code(["r": db]))
        let move = CloudMove(provider: "catalyst", c: relay, ck: relayKey, at: 1_000)
        stores.seed(host: dbHost, path: "channels/\(channelId)/state/move", try sealed(move))

        let before = Channel(pairing: old, deviceId: "phone", transport: stores, streams: FakeLines([]), sockets: FakeSockets())
        try await before.touchPresence()
        XCTAssertEqual(stores.writes, ["\(dbHost) channels/\(channelId)/state/presence"])

        // Read on the old store, verified like any Mac document, then followed.
        let seen = try await before.move()
        XCTAssertEqual(seen, move)
        let moved = try XCTUnwrap(old.applying(try XCTUnwrap(seen)))
        XCTAssertEqual(moved.cu, relay)
        XCTAssertEqual(moved.ck, relayKey)
        XCTAssertNil(moved.r)
        XCTAssertEqual(moved.ma, 1_000)
        XCTAssertEqual(moved.k, old.k)
        XCTAssertEqual(moved.c, old.c)

        let after = Channel(pairing: moved, deviceId: "phone", transport: stores, streams: FakeLines([]), sockets: FakeSockets())
        try await after.touchPresence()
        XCTAssertEqual(stores.writes.last, "\(relayHost) channels/\(channelId)/state/presence")
        XCTAssertEqual(stores.writes.filter { $0.hasPrefix(dbHost) }.count, 1, "nothing more was written to the old store")
        XCTAssertTrue(stores.has(host: relayHost, path: "channels/\(channelId)/state/presence"))

        // And back: the Mac moves to Firebase later; an older move is never followed again.
        let back = CloudMove(provider: "firebase", r: db, at: 2_000)
        let home = try XCTUnwrap(moved.applying(back))
        XCTAssertEqual(home.r, db)
        XCTAssertNil(home.cu)
        XCTAssertNil(home.ck)
        XCTAssertNil(home.applying(move), "an older move is ignored")
        XCTAssertNil(moved.applying(move), "the same move twice is nothing")
    }

    func testAMoveIsOnlyFollowedWhenItIsSealedByTheMacAndNamesAnAcceptedHost() async throws {
        let stores = TwoStores()
        let dbHost = URL(string: db)!.host!
        let pairing = try PairingPayload.parse(try code(["r": db]))
        let channel = Channel(pairing: pairing, deviceId: "phone", transport: stores, streams: FakeLines([]), sockets: FakeSockets())
        let path = "channels/\(channelId)/state/move"

        // Sealed with another key: cannot be opened.
        stores.seed(host: dbHost, path: path, try sealed(CloudMove(provider: "catalyst", c: relay, ck: relayKey, at: 5), key: Data(repeating: 9, count: 32).base64EncodedString()))
        let forged = try await channel.move()
        XCTAssertNil(forged)

        // Sealed right, but aimed at a host a pairing code could not name.
        for bad in [CloudMove(provider: "catalyst", c: "https://evil.example.com/server/x", ck: relayKey, at: 5),
                    CloudMove(provider: "catalyst", c: relay, ck: nil, at: 5),
                    CloudMove(provider: "firebase", r: "https://evil.example.com", at: 5),
                    CloudMove(provider: "other", r: db, at: 5),
                    CloudMove(v: 2, provider: "firebase", r: db, at: 5)] {
            stores.seed(host: dbHost, path: path, try sealed(bad))
            let refused = try await channel.move()
            XCTAssertNil(refused, "\(bad)")
            XCTAssertNil(pairing.applying(bad))
        }

        // No document: no move.
        stores.seed(host: dbHost, path: path, [:])
        let none = try await Channel(pairing: pairing, deviceId: "p", transport: TwoStores(), streams: FakeLines([]), sockets: FakeSockets()).move()
        XCTAssertNil(none)
    }

    func testTheMoveDocumentOnTheWireIsTheContractsShape() throws {
        let json = #"{"v":1,"provider":"catalyst","c":"\#(relay)","ck":"\#(relayKey)","at":1730000000000}"#
        let move = try JSONDecoder().decode(CloudMove.self, from: Data(json.utf8))
        XCTAssertEqual(move, CloudMove(provider: "catalyst", c: relay, ck: relayKey, at: 1_730_000_000_000))
        XCTAssertTrue(move.isValid)
        let firebase = try JSONDecoder().decode(CloudMove.self, from: Data(#"{"v":1,"provider":"firebase","r":"\#(db)","at":1}"#.utf8))
        XCTAssertTrue(firebase.isValid)
    }
}
