import Foundation
import XCTest
@testable import SqueakCore

/// The stream behaves while Data Streams reconnects and refreshes: nothing blanks, nothing echoes, nothing stalls.
final class StableLiveTests: XCTestCase {
    let relay = "https://squeak-1.development.catalystserverless.in/server/squeak_relay"
    let relayKey = "k3y_k3y_k3y_k3y_k3y_k3y_k3y_k3y_k3y_k3y_xx"
    let key = Data(repeating: 7, count: 32).base64EncodedString()

    private func client(_ http: FakeRelay, _ sockets: FakeSockets, timing: CatalystTiming = CatalystClientTests.fast) -> CatalystClient {
        CatalystClient(relayURL: relay + "/", relayKey: relayKey, transport: http, sockets: sockets, timing: timing)
    }

    func testANumericStreamingIdIsAcked() async throws {
        let http = FakeRelay()
        let sockets = FakeSockets()
        let store = client(http, sockets)
        let stop = store.watch("channels/c/state") {}
        _ = await eventually { sockets.sockets.count == 1 }
        let socket = sockets.sockets[0]
        socket.authOK()
        socket.push(#"[{"mtype":"650","msg":{"opr":"event","data":{"data":"{\"p\":\"channels/c/state\"}","streamingId":42}}}]"#)
        let acked = await eventually {
            socket.sent.contains(#"{"streamingId":"42","type":"ack"}"#) || socket.sent.contains(#"{"type":"ack","streamingId":"42"}"#)
        }
        XCTAssertTrue(acked)
        stop()
    }

    func testAPresenceNoticeWakesNobodyButOtherStateWritesDo() async throws {
        let http = FakeRelay()
        let sockets = FakeSockets()
        let store = client(http, sockets)
        let wakes = Counter()
        let stop = store.watch("channels/c/state") { wakes.bump() }
        _ = await eventually { sockets.sockets.count == 1 }
        let socket = sockets.sockets[0]
        socket.authOK()
        _ = await eventually { wakes.count == 1 }
        socket.rawNotice(#"{"p":"channels/c/state","k":"presence"}"#, id: "1")
        socket.rawNotice(#"{"t":"\#(CatalystClient.noticeTag("c"))","k":"presence"}"#, id: "2")
        try await Task.sleep(for: .milliseconds(120))
        XCTAssertEqual(wakes.count, 1)
        socket.rawNotice(#"{"p":"channels/c/state","k":"snapshot"}"#, id: "3")
        socket.rawNotice(#"{"p":"channels/c/state"}"#, id: "4") // an older relay names no document
        let woke = await eventually { wakes.count == 3 }
        XCTAssertTrue(woke)
        stop()
    }

    func testASilentSocketIsDroppedAndReconnected() async throws {
        let http = FakeRelay()
        let sockets = FakeSockets()
        var timing = CatalystClientTests.fast
        timing.stall = 0.3; timing.keepAlive = 100; timing.ping = 100
        let store = client(http, sockets, timing: timing)
        let stop = store.watch("channels/c/state") {}
        _ = await eventually { sockets.sockets.count == 1 }
        sockets.sockets[0].authOK()
        // Nothing more is heard: the stall watch ends the session and a new one starts.
        let again = await eventually { sockets.sockets.count == 2 }
        XCTAssertTrue(again)
        stop()
    }

    func testTheRetryWaitIsSpreadOverHalfToAllOfTheBackoff() {
        XCTAssertEqual(CatalystHub.jittered(10, random: 0), 5)
        XCTAssertEqual(CatalystHub.jittered(10, random: 1), 10)
        XCTAssertEqual(CatalystHub.jittered(10, random: 0.5), 7.5)
    }

    func testAMissingOrEmptyRecentDocumentIsNotARecentEvent() async throws {
        let recent = try ChannelCrypto.seal(PhoneRecent(v: 1, seq: 5, recent: [], recentMore: nil, workspaces: nil, projectIcons: nil, chatModels: nil), key: key)
        let snap = try ChannelCrypto.seal(
            try JSONDecoder().decode(PhoneSnapshot.self, from: Data(#"{"v":1,"mac":"Mac","generatedAt":"","duck":{"blockedCount":0,"workingCount":0},"sessions":[]}"#.utf8)),
            key: key)
        let db = "https://x-default-rtdb.firebasedatabase.app"
        func body(_ path: String, _ data: Any) -> String {
            "data: " + String(data: try! JSONSerialization.data(withJSONObject: ["path": path, "data": data], options: .fragmentsAllowed), encoding: .utf8)!
        }
        let lines = HeldLines([
            "event: put", body("/", ["recent": ["box": recent]]),
            // The list now says there is no recent document (a short read looks like this), then a view arrives.
            "event: put", body("/recent", NSNull()),
            "event: put", body("/snapshot", ["box": snap]),
        ])
        let pairing = PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Mac", r: db)
        let channel = Channel(pairing: pairing, deviceId: "d", transport: FakeTransport(), streams: lines)
        var seen: [StateEvent] = []
        let stream = await channel.stateEvents()
        for await event in try XCTUnwrap(stream) {
            seen.append(event)
            if case .snapshot = event { break }
        }
        let recents = seen.compactMap { event -> PhoneRecent?? in if case .recent(let value) = event { return .some(value) } else { return nil } }
        XCTAssertEqual(recents.count, 1)
        XCTAssertEqual(recents.first??.seq, 5)
    }
}
