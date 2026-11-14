import Foundation
import XCTest
@testable import SqueakCore

/// A scripted Data Streams socket: frames the server "sends" are pushed in; what the client sends is recorded.
final class FakeSocket: WebSocketConnection, @unchecked Sendable {
    let url: URL
    private let lock = NSLock()
    private var _sent: [String] = []
    private var _closed = false
    private let stream: AsyncStream<String>
    private let inbox: AsyncStream<String>.Continuation
    private var iterator: AsyncStream<String>.AsyncIterator

    init(url: URL) {
        self.url = url
        (stream, inbox) = AsyncStream<String>.makeStream()
        iterator = stream.makeAsyncIterator()
    }

    var sent: [String] { lock.withLock { _sent } }
    var closed: Bool { lock.withLock { _closed } }

    func send(_ text: String) async throws { lock.withLock { _sent.append(text) } }
    func receive() async throws -> String? {
        var it = iterator
        let next = await it.next()
        iterator = it
        return next
    }
    func close() { lock.withLock { _closed = true }; inbox.finish() }

    func push(_ text: String) { inbox.yield(text) }
    /// The server drops the connection.
    func drop() { inbox.finish() }
    func authOK(sid: String = "sid1", uid: String = "uid1") {
        push(#"[{"mtype":"0","msg":{"sid":"\#(sid)","uid":"\#(uid)"}}]"#)
    }
    /// A raw notice body (already JSON text), for tags and malformed bodies.
    func rawNotice(_ body: String, id: String = "1") {
        let escaped = body.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        push(#"[{"mtype":"650","msg":{"opr":"event","data":{"data":"\#(escaped)","streamingId":"\#(id)"}}}]"#)
    }
    func notice(_ path: String, id: String = "1") {
        let data = #"{\"p\":\"\#(path)\"}"#
        push(#"[{"mtype":"650","msg":{"opr":"event","data":{"data":"\#(data)","streamingId":"\#(id)"}}}]"#)
    }
}

final class FakeSockets: WebSocketTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _sockets: [FakeSocket] = []
    var sockets: [FakeSocket] { lock.withLock { _sockets } }
    func connect(_ url: URL) -> WebSocketConnection {
        let socket = FakeSocket(url: url)
        lock.withLock { _sockets.append(socket) }
        return socket
    }
}

/// The relay: records requests, answers from a table or a handler.
final class FakeRelay: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _requests: [URLRequest] = []
    var tokens = 0
    var hosts = ["in1-dms.zoho.in"]
    var handler: (@Sendable (URLRequest) -> (Int, String))?

    var requests: [URLRequest] { lock.withLock { _requests } }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        lock.withLock { _requests.append(request) }
        var (status, body) = (200, "{}")
        if request.url?.path.hasSuffix("/token") == true {
            let host = lock.withLock { () -> String in tokens += 1; return hosts[min(tokens, hosts.count) - 1] }
            body = #"{"url":"\#(host)","key":"tk\#(tokens)","wssId":"zu\#(tokens)"}"#
        } else if let handler {
            (status, body) = handler(request)
        }
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

func eventually(_ seconds: Double = 3, _ condition: () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func bump() { lock.withLock { value += 1 } }
    var count: Int { lock.withLock { value } }
}

final class CatalystClientTests: XCTestCase {
    let relay = "https://squeak-1.development.catalystserverless.in/server/squeak_relay"
    let relayKey = "k3y_k3y_k3y_k3y_k3y_k3y_k3y_k3y_k3y_k3y_xx"

    private func client(_ http: FakeRelay, _ sockets: FakeSockets = FakeSockets(), channel: String? = nil, timing: CatalystTiming = fast) -> CatalystClient {
        CatalystClient(relayURL: relay + "/", relayKey: relayKey, channel: channel, transport: http, sockets: sockets, timing: timing)
    }

    static var fast: CatalystTiming {
        var timing = CatalystTiming()
        timing.keepAlive = 0.05; timing.ping = 0.08; timing.safetyPoll = 100; timing.retryMin = 0.02; timing.retryMax = 0.05
        return timing
    }

    /* ---------- the relay over HTTP ---------- */

    func testDocumentsGoThroughTheRelayWithItsKey() async throws {
        let http = FakeRelay()
        http.handler = { request in
            switch request.httpMethod ?? "" {
            case "GET" where request.url?.path.hasSuffix("/doc") == true: return (200, #"{"doc":{"box":"b","sig":"s","device":"d","at":5}}"#)
            case "GET": return (200, #"{"items":[{"id":"a","doc":{"box":"1"}},{"id":"b","doc":{"box":"2","at":9}}]}"#)
            default: return (204, "")
            }
        }
        let store = client(http)
        let doc = try await store.get("channels/c/state/snapshot")
        XCTAssertEqual(doc, ChannelDocument(box: "b", sig: "s", device: "d", at: 5))
        XCTAssertEqual(http.requests[0].url?.absoluteString, relay + "/doc?path=channels%2Fc%2Fstate%2Fsnapshot")
        XCTAssertEqual(http.requests[0].value(forHTTPHeaderField: "x-squeak-relay"), relayKey)

        try await store.set("channels/c/commands/x", ChannelDocument(box: "b", sig: "s", device: "d"))
        XCTAssertEqual(http.requests[1].httpMethod, "PUT")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: http.requests[1].httpBody!) as? [String: [String: String]])
        XCTAssertEqual(body, ["doc": ["box": "b", "sig": "s", "device": "d"]])
        XCTAssertEqual(http.requests[1].value(forHTTPHeaderField: "x-squeak-relay"), relayKey)

        try await store.delete("channels/c/commands/x")
        XCTAssertEqual(http.requests[2].httpMethod, "DELETE")

        let items = try await store.list("channels/c/results")
        XCTAssertEqual(items, [CloudListing(id: "a", doc: ChannelDocument(box: "1")), CloudListing(id: "b", doc: ChannelDocument(box: "2", at: 9))])
        XCTAssertEqual(http.requests[3].url?.absoluteString, relay + "/list?prefix=channels%2Fc%2Fresults")
    }

    func testMissingAndRefusedAnswers() async throws {
        let http = FakeRelay()
        http.handler = { request in request.httpMethod == "GET" ? (404, "") : (401, "") }
        let store = client(http)
        let missing = try await store.get("channels/c/state/x")
        XCTAssertNil(missing)
        do { try await store.set("channels/c/state/x", ChannelDocument(box: "b")); XCTFail("accepted a 401") } catch {
            XCTAssertEqual(error as? CatalystClient.Failure, .http(401))
        }
    }

    func testRelayHostsAreCatalystsOwn() {
        for ok in ["https://a.development.catalystserverless.in/server/squeak_relay", "https://x.catalystserverless.com", "https://x.catalystserverless.com.au/",
                   "https://x.catalystserverless.eu", "https://x.catalystserverless.jp", "https://x.catalystserverless.ca", "https://x.catalystserverless.sa",
                   "https://svc.catalystappsail.in", "https://svc.catalystappsail.com"] {
            XCTAssertTrue(Channel.isRelayURL(ok), ok)
        }
        for bad in ["http://a.catalystserverless.in", "https://catalystserverless.in", "https://evilcatalystserverless.in", "https://a.catalystserverless.in.evil.com",
                    "https://a.catalystserverless.xyz", "https://a.firebaseio.com", "https://a.catalystserverless.in/?x=1", "https://u@a.catalystserverless.in", "not a url"] {
            XCTAssertFalse(Channel.isRelayURL(bad), bad)
        }
    }

    func testStreamsHostsAreAllowListed() {
        XCTAssertTrue(CatalystClient.isStreamsHost("in1-dms.zoho.in"))
        XCTAssertTrue(CatalystClient.isStreamsHost("us4-dms.zoho.com"))
        XCTAssertTrue(CatalystClient.isStreamsHost("au2-dms.zoho.com.au"))
        XCTAssertFalse(CatalystClient.isStreamsHost("in1-dms.zoho.in.evil.com"))
        XCTAssertFalse(CatalystClient.isStreamsHost("evil.com"))
        XCTAssertFalse(CatalystClient.isStreamsHost("in1-dms.evil.in"))
    }

    private func tokenBodies(_ http: FakeRelay) -> [[String: String]] {
        http.requests.filter { $0.url?.path.hasSuffix("/token") == true }.compactMap {
            $0.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] }
        }
    }

    func testTheTokenRequestNamesTheMacsChannelSoTheRelayCanGiveItsOwnStream() async throws {
        let http = FakeRelay()
        let store = client(http, channel: "chan_ABCDEFGHIJKLMNOPQRSTUV")
        let stop = store.watch("channels/chan_ABCDEFGHIJKLMNOPQRSTUV/state") {}
        let asked = await eventually { http.tokens >= 1 }
        XCTAssertTrue(asked)
        XCTAssertEqual(tokenBodies(http).first?["channel"], "chan_ABCDEFGHIJKLMNOPQRSTUV")
        XCTAssertNotNil(tokenBodies(http).first?["name"])
        stop()
    }

    func testWithoutAChannelTheTokenRequestIsTheOldOneAndTheSharedStreamStillServes() async throws {
        let http = FakeRelay()
        let sockets = FakeSockets()
        let store = client(http, sockets)
        let stop = store.watch("channels/c/state") {}
        let connected = await eventually { sockets.sockets.count == 1 }
        XCTAssertTrue(connected)
        XCTAssertNil(tokenBodies(http).first?["channel"])
        XCTAssertEqual(tokenBodies(http).first?.keys.sorted(), ["name"])
        stop()
    }

    func testATokenForAnotherHostIsRefusedAndNeverConnected() async throws {
        let http = FakeRelay()
        http.hosts = ["evil.example.com"]
        let sockets = FakeSockets()
        let store = client(http, sockets)
        let changes = try XCTUnwrap(store.changes("channels/c/state"))
        let task = Task { for await _ in changes {} }
        let asked = await eventually { http.tokens >= 2 }
        XCTAssertTrue(asked)
        XCTAssertTrue(sockets.sockets.isEmpty)
        task.cancel()
    }

    /* ---------- the one socket ---------- */

    func testOneSocketSubscribesAcksAndFansOutByPrefix() async throws {
        let http = FakeRelay()
        let sockets = FakeSockets()
        let store = client(http, sockets)
        let state = Counter(), results = Counter(), whole = Counter()
        let stop1 = store.watch("channels/c/state/snapshot") { state.bump() }
        let stop2 = store.watch("channels/c/results") { results.bump() }
        let stop3 = store.watch("channels/c") { whole.bump() }
        let connected = await eventually { sockets.sockets.count == 1 }
        XCTAssertTrue(connected)
        let socket = sockets.sockets[0]
        let url = try XCTUnwrap(URLComponents(url: socket.url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(url.scheme, "wss")
        XCTAssertEqual(url.host, "in1-dms.zoho.in")
        XCTAssertEqual(url.path, "/wsconnect")
        XCTAssertEqual(url.queryItems?.first { $0.name == "prd" }?.value, "CY")
        XCTAssertEqual(url.queryItems?.first { $0.name == "zuid" }?.value, "zu1")
        XCTAssertEqual(url.queryItems?.first { $0.name == "key" }?.value, "tk1")
        XCTAssertEqual(http.requests.first?.url?.path, "/server/squeak_relay/token")
        XCTAssertEqual(http.requests.first?.httpMethod, "POST")
        XCTAssertEqual(http.requests.first?.value(forHTTPHeaderField: "x-squeak-relay"), relayKey)

        socket.authOK()
        let subscribed = await eventually { socket.sent.contains(#"{"type":"con","value":"subscribe","streamingId":"0"}"#) }
        XCTAssertTrue(subscribed)
        // Connecting tells every watch to read once.
        let first = await eventually { state.count == 1 && results.count == 1 && whole.count == 1 }
        XCTAssertTrue(first)

        socket.notice("channels/c/state", id: "7")
        let acked = await eventually { socket.sent.contains(#"{"streamingId":"7","type":"ack"}"#) || socket.sent.contains(#"{"type":"ack","streamingId":"7"}"#) }
        XCTAssertTrue(acked)
        let fan = await eventually { state.count == 2 && whole.count == 2 }
        XCTAssertTrue(fan)
        XCTAssertEqual(results.count, 1)

        socket.notice("channels/c/results", id: "8")
        let two = await eventually { results.count == 2 && whole.count == 3 }
        XCTAssertTrue(two)
        XCTAssertEqual(state.count, 2)
        // A notice for another channel touches nothing.
        socket.notice("channels/other/state", id: "9")
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(whole.count, 3)
        XCTAssertEqual(sockets.sockets.count, 1)
        [stop1, stop2, stop3].forEach { $0() }
    }

    func testNoticeTagMatchesThePinnedVector() {
        XCTAssertEqual(CatalystClient.noticeTag(String(repeating: "A", count: 30)), "uhjd2c2uhsob5iRwl6Scxr")
    }

    func testATagNoticeWakesOnlyThatChannelsListeners() async throws {
        let http = FakeRelay()
        let sockets = FakeSockets()
        let store = client(http, sockets)
        let mine = String(repeating: "A", count: 30), other = String(repeating: "B", count: 30)
        let state = Counter(), results = Counter(), foreign = Counter()
        let s1 = store.watch("channels/\(mine)/state") { state.bump() }
        let s2 = store.watch("channels/\(mine)/results") { results.bump() }
        let s3 = store.watch("channels/\(other)/state") { foreign.bump() }
        _ = await eventually { sockets.sockets.count == 1 }
        let socket = sockets.sockets[0]
        socket.authOK()
        let first = await eventually { state.count == 1 && results.count == 1 && foreign.count == 1 }
        XCTAssertTrue(first)

        // The kind is not carried: every listener of the channel wakes, no other channel's.
        socket.rawNotice(#"{"t":"uhjd2c2uhsob5iRwl6Scxr"}"#, id: "1")
        let woke = await eventually { state.count == 2 && results.count == 2 }
        XCTAssertTrue(woke)
        XCTAssertEqual(foreign.count, 1)

        // A tag no listener has is ignored.
        socket.rawNotice(#"{"t":"zzzzzzzzzzzzzzzzzzzzzz"}"#, id: "2")
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(state.count, 2); XCTAssertEqual(results.count, 2); XCTAssertEqual(foreign.count, 1)

        // A path notice is unchanged.
        socket.notice("channels/\(other)/state", id: "3")
        let path = await eventually { foreign.count == 2 }
        XCTAssertTrue(path)
        XCTAssertEqual(state.count, 2)

        // Malformed: re-read everything.
        socket.rawNotice(#"{"x":1}"#, id: "4")
        let resync = await eventually { state.count == 3 && results.count == 3 && foreign.count == 3 }
        XCTAssertTrue(resync)
        socket.rawNotice("not json", id: "5")
        let resync2 = await eventually { state.count == 4 && results.count == 4 && foreign.count == 4 }
        XCTAssertTrue(resync2)
        [s1, s2, s3].forEach { $0() }
    }

    func testKeepAliveAndPing() async throws {
        let sockets = FakeSockets()
        let store = client(FakeRelay(), sockets)
        let stop = store.watch("channels/c/state") {}
        _ = await eventually { sockets.sockets.count == 1 }
        let socket = sockets.sockets[0]
        socket.authOK()
        let alive = await eventually { socket.sent.contains("-") && socket.sent.contains(#"{"type":"con","value":"ping"}"#) }
        XCTAssertTrue(alive)
        stop()
    }

    func testLeavingUnsubscribesBeforeClosing() async throws {
        let sockets = FakeSockets()
        let store = client(FakeRelay(), sockets)
        let stop = store.watch("channels/c/state") {}
        _ = await eventually { sockets.sockets.count == 1 }
        let socket = sockets.sockets[0]
        socket.authOK()
        _ = await eventually { socket.sent.contains { $0.contains("subscribe\"") && !$0.contains("unsubscribe") } }
        stop()
        let closed = await eventually { socket.closed }
        XCTAssertTrue(closed)
        XCTAssertEqual(socket.sent.last(where: { $0.contains("con") && $0.contains("subscribe") }), #"{"type":"con","value":"unsubscribe"}"#)
        // And no second socket appears afterwards.
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(sockets.sockets.count, 1)
    }

    func testReconnectReleasesTheOldSessionThenResubscribesOnAFreshToken() async throws {
        let http = FakeRelay()
        let sockets = FakeSockets()
        let store = client(http, sockets)
        let seen = Counter()
        let stop = store.watch("channels/c/state") { seen.bump() }
        _ = await eventually { sockets.sockets.count == 1 }
        let first = sockets.sockets[0]
        first.authOK(sid: "a")
        _ = await eventually { seen.count == 1 }

        first.drop()
        let second = await eventually { sockets.sockets.count == 2 }
        XCTAssertTrue(second)
        XCTAssertEqual(http.tokens, 2)
        XCTAssertTrue(first.sent.contains(#"{"type":"con","value":"unsubscribe"}"#))
        XCTAssertTrue(first.closed)
        let url = try XCTUnwrap(URLComponents(url: sockets.sockets[1].url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(url.queryItems?.first { $0.name == "zuid" }?.value, "zu2")
        sockets.sockets[1].authOK(sid: "b")
        _ = await eventually { sockets.sockets[1].sent.contains(#"{"type":"con","value":"subscribe","streamingId":"0"}"#) }
        // Live only: what was missed is read again.
        let again = await eventually { seen.count == 2 }
        XCTAssertTrue(again)
        stop()
    }

    func testAnAuthFailureReconnects() async throws {
        let http = FakeRelay()
        let sockets = FakeSockets()
        let store = client(http, sockets)
        let stop = store.watch("channels/c/state") {}
        _ = await eventually { sockets.sockets.count == 1 }
        sockets.sockets[0].push(#"[{"mtype":"-5"}]"#)
        let retried = await eventually { sockets.sockets.count == 2 }
        XCTAssertTrue(retried)
        stop()
    }

    func testAHostSwitchReconnectsThereWithTheSessionIds() async throws {
        let http = FakeRelay()
        let sockets = FakeSockets()
        let store = client(http, sockets)
        let stop = store.watch("channels/c/state") {}
        _ = await eventually { sockets.sockets.count == 1 }
        let first = sockets.sockets[0]
        first.authOK(sid: "S", uid: "U")
        _ = await eventually { first.sent.count >= 1 }
        first.push(#"[{"mtype":"-1","msg":{"primarydc":"in2","in2":"in2-dms.zoho.in"}}]"#)
        let moved = await eventually { sockets.sockets.count == 2 }
        XCTAssertTrue(moved)
        let url = try XCTUnwrap(URLComponents(url: sockets.sockets[1].url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(url.host, "in2-dms.zoho.in")
        XCTAssertEqual(url.queryItems?.first { $0.name == "i" }?.value, "S")
        XCTAssertEqual(url.queryItems?.first { $0.name == "c" }?.value, "U")
        XCTAssertEqual(url.queryItems?.first { $0.name == "key" }?.value, "tk1")
        XCTAssertEqual(http.tokens, 1)
        stop()
    }

    func testAHostSwitchToAnotherHostIsRefused() async throws {
        let http = FakeRelay()
        let sockets = FakeSockets()
        let store = client(http, sockets)
        let stop = store.watch("channels/c/state") {}
        _ = await eventually { sockets.sockets.count == 1 }
        sockets.sockets[0].push(#"[{"mtype":"-1","msg":{"primarydc":"x","x":"evil.example.com"}}]"#)
        _ = await eventually { sockets.sockets.count == 2 }
        for socket in sockets.sockets { XCTAssertEqual(socket.url.host, "in1-dms.zoho.in") }
        stop()
    }

    func testAStateStreamGetsEveryDocumentFromOneListPerNotice() async throws {
        let http = FakeRelay()
        let listed = Counter()
        http.handler = { request in
            guard request.url?.path.hasSuffix("/list") == true else { return (204, "") }
            listed.bump()
            return (200, #"{"items":[{"id":"snapshot","doc":{"box":"S"}},{"id":"alive","doc":{"box":"A"}}]}"#)
        }
        let sockets = FakeSockets()
        let store = client(http, sockets)
        let events = try XCTUnwrap(store.events(in: "channels/c/state", documents: ["snapshot", "alive", "move"]))
        let received = EventLog()
        let task = Task { for await event in events { received.add(event) } }
        _ = await eventually { sockets.sockets.count == 1 }
        sockets.sockets[0].authOK()
        let loaded = await eventually {
            received.all.contains(.document("snapshot", .value(ChannelDocument(box: "S")))) && received.all.contains(.document("move", .value(nil)))
        }
        XCTAssertTrue(loaded)
        XCTAssertTrue(received.all.contains(.connected))
        XCTAssertTrue(received.all.contains(.document("alive", .value(ChannelDocument(box: "A")))))
        XCTAssertEqual(listed.count, 1)
        task.cancel()
    }
}

final class EventLog: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [ChannelEvent] = []
    func add(_ event: ChannelEvent) { lock.withLock { events.append(event) } }
    var all: [ChannelEvent] { lock.withLock { events } }
}
