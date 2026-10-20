import Foundation
import XCTest
@testable import SqueakCore

/// Lines for one connection that then stays open, as a live stream does.
final class HeldLines: LineStreamTransport, @unchecked Sendable {
    let lines: [String]
    var requests = 0
    init(_ lines: [String]) { self.lines = lines }
    func lines(for request: URLRequest) async throws -> AsyncThrowingStream<String, Error> {
        requests += 1
        let lines = requests == 1 ? lines : []
        return AsyncThrowingStream { continuation in for line in lines { continuation.yield(line) } }
    }
}

final class StreamHubTests: XCTestCase {
    let db = "https://x-default-rtdb.firebasedatabase.app"
    let key = Data(repeating: 7, count: 32).base64EncodedString()

    private func sealedView(mac: String) throws -> String {
        let json = #"{"v":1,"mac":"\#(mac)","generatedAt":"","duck":{"blockedCount":0,"workingCount":0},"sessions":[]}"#
        return try ChannelCrypto.seal(try JSONDecoder().decode(PhoneSnapshot.self, from: Data(json.utf8)), key: key)
    }

    private func line(_ path: String, _ data: Any) -> String {
        let body = try! JSONSerialization.data(withJSONObject: ["path": path, "data": data], options: .fragmentsAllowed)
        return "data: " + String(data: body, encoding: .utf8)!
    }

    func testListenersOnOnePathShareOneConnection() async throws {
        let lines = HeldLines(["event: put", line("/", ["box": "one"])])
        let client = RealtimeDatabaseClient(databaseURL: db, streams: lines)
        let holder = try XCTUnwrap(client.documents("channels/c/results"))
        let keepOpen = Task { for await _ in holder {} }
        defer { keepOpen.cancel() }
        let first = try XCTUnwrap(client.documents("channels/c/results"))
        for await change in first { XCTAssertEqual(change, .value(ChannelDocument(box: "one"))); break }

        // A second listener (a command waiting for its result) joins the open
        // stream: no new connection, and it is told to read once, since it
        // never saw the value sent on connect.
        let second = try XCTUnwrap(client.documents("channels/c/results"))
        for await change in second { XCTAssertEqual(change, .refetch); break }
        let health = await client.streamHealth()
        XCTAssertEqual(lines.requests, 1)
        XCTAssertEqual(health.first?.connected, true)
    }

    func testACollectionEventIsSplitIntoItsDocuments() {
        let names = ["snapshot", "alive"]
        func changes(_ event: String, _ data: String?) -> [String: DocumentChange] {
            Dictionary(uniqueKeysWithValues: RealtimeDatabaseClient.childChanges(event: event, data: data, names: names))
        }
        // On connect: the whole collection; a document missing from it is gone.
        XCTAssertEqual(changes("put", #"{"path":"/","data":{"snapshot":{"box":"s"},"presence":{"box":"p"}}}"#),
                       ["snapshot": .value(ChannelDocument(box: "s")), "alive": .value(nil)])
        // One document rewritten; the phone's own presence is not one it watches.
        XCTAssertEqual(changes("put", #"{"path":"/alive","data":{"box":"a","at":2}}"#), ["alive": .value(ChannelDocument(box: "a", at: 2))])
        XCTAssertEqual(changes("put", #"{"path":"/presence","data":{"box":"p"}}"#), [:])
        XCTAssertEqual(changes("put", #"{"path":"/snapshot","data":null}"#), ["snapshot": .value(nil)])
        // A patch names only what changed; a change inside a document is re-read.
        XCTAssertEqual(changes("patch", #"{"path":"/","data":{"alive":{"box":"a"}}}"#), ["alive": .value(ChannelDocument(box: "a"))])
        XCTAssertEqual(changes("put", #"{"path":"/snapshot/at","data":5}"#), ["snapshot": .refetch])
        XCTAssertEqual(changes("put", nil), ["snapshot": .refetch, "alive": .refetch])
    }

    func testAViewThatCannotBeOpenedDoesNotEndTheStream() async throws {
        let good = try sealedView(mac: "Mac")
        let lines = FakeLines([[
            "event: put", line("/", ["snapshot": ["box": "not a box"]]),
            "event: keep-alive", "data: null",
            "event: put", line("/snapshot", ["box": good]),
        ]])
        let pairing = PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Mac", r: db)
        let channel = Channel(pairing: pairing, deviceId: "d", transport: FakeTransport(), streams: lines)
        var seen: [StateEvent] = []
        let events = await channel.stateEvents()
        for await event in try XCTUnwrap(events) {
            seen.append(event)
            if case .snapshot = event { break }
        }
        XCTAssertEqual(seen.first, .connected)
        XCTAssertTrue(seen.contains(.needsRead))
        XCTAssertEqual(seen.filter { $0 == .heard }.count, 4) // connect, the bad view, the keep-alive, the good view
        guard case .snapshot(let view) = seen.last else { return XCTFail("no view") }
        XCTAssertEqual(view?.mac, "Mac")
    }

    func testADroppedStreamIsReconnectedWithinASecond() async throws {
        let lines = FakeLines([["event: put", line("/", ["box": "one"])], ["event: put", line("/", ["box": "two"])]])
        let client = RealtimeDatabaseClient(databaseURL: db, streams: lines)
        let started = Date()
        var seen: [DocumentChange] = []
        for await change in try XCTUnwrap(client.documents("channels/c/state/snapshot")) {
            seen.append(change)
            if seen.count == 2 { break }
        }
        XCTAssertEqual(seen, [.value(ChannelDocument(box: "one")), .value(ChannelDocument(box: "two"))])
        XCTAssertLessThan(Date().timeIntervalSince(started), 1.5)
    }

    func testStreamsUseTheirOwnSessionSoRequestsNeverQueueBehindThem() {
        XCTAssertFalse(Channel.streamSession === URLSession.shared)
        XCTAssertGreaterThanOrEqual(Channel.streamSession.configuration.httpMaximumConnectionsPerHost, 6)
    }

    func testALiveTurnGetsItsHistoryFromItsOwnDocument() async throws {
        let sessionKey = "claude-transcript:s2"
        let handle = LiveTurn.handle(for: sessionKey)
        var turn = LiveTurn(key: sessionKey, working: true, total: 1, steps: [.init(kind: "note", text: "n")])
        turn.split = true
        let turnBox = try ChannelCrypto.seal(turn, key: key)
        let historyBox = try ChannelCrypto.seal(
            LiveHistory(v: 1, key: sessionKey, history: [.init(role: "user", text: "Fix it")]), key: key)
        let lines = HeldLines([
            "event: put", line("/", [handle: ["box": turnBox]]),
            "event: put", line("/\(handle)-h", ["box": historyBox]),
        ])
        let pairing = PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Mac", r: db)
        let channel = Channel(pairing: pairing, deviceId: "d", transport: FakeTransport(), streams: lines)
        var seen: [LiveTurn?] = []
        let turns = await channel.liveTurns(for: sessionKey)
        for await next in try XCTUnwrap(turns) {
            seen.append(next)
            if next?.history != nil { break }
        }
        XCTAssertNil(seen.first??.history) // the turn shows before its history arrives
        XCTAssertEqual(seen.last??.history?.first?.text, "Fix it")
        XCTAssertEqual(seen.last??.steps.first?.text, "n")
        XCTAssertEqual(lines.requests, 1) // both documents over one stream
    }
}
