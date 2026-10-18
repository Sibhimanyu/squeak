import Network
import XCTest

@testable import SqueakMacCore

/// Loopback stand-in for api.conductor.build: echoes HTTP as JSON, echoes WS text.
final class FakeUpstream: @unchecked Sendable {
    private let queue = DispatchQueue(label: "fake.upstream")
    private var listener: NWListener?
    private var keep: [Any] = []
    private let lock = NSLock()

    func start() async throws -> UInt16 {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        let l = try NWListener(using: params)
        l.newConnectionHandler = { [self] c in c.start(queue: queue); read(c, Data()) }
        let once = OnceFlag()
        let port: UInt16 = try await withCheckedThrowingContinuation { cont in
            l.stateUpdateHandler = { st in
                if case .ready = st, once.fire() { cont.resume(returning: l.port!.rawValue) }
                if case .failed(let e) = st, once.fire() { cont.resume(throwing: e) }
            }
            l.start(queue: queue)
        }
        listener = l
        return port
    }

    func stop() { listener?.cancel() }

    private func read(_ c: NWConnection, _ buf: Data) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [self] data, _, done, err in
            var b = buf
            if let data { b.append(data) }
            guard let r = b.range(of: RelayHTTPHead.terminator), let head = RelayHTTPHead.parse(b.subdata(in: b.startIndex..<r.lowerBound)) else {
                if err == nil, !done { read(c, b) } else { c.cancel() }
                return
            }
            let want = Int(head.header("content-length") ?? "0") ?? 0
            let body = b.subdata(in: r.upperBound..<b.endIndex)
            if body.count < want { read(c, b); return }
            if head.isWebSocketUpgrade, let key = head.header("sec-websocket-key") {
                let hs = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(RelayWS.acceptKey(key))\r\n\r\n"
                c.send(content: Data(hs.utf8), completion: .contentProcessed { [self] _ in
                    let ws = RelayWebSocketConnection(connection: c, initial: body)
                    lock.withLock { keep.append(ws) }
                    ws.onText { ws.sendText("echo:\($0)") }
                    ws.start()
                })
                return
            }
            let json = RelayJSON.obj([
                "proxied": true, "method": .string(head.method), "path": .string(head.target),
                "host": .string(head.header("host") ?? ""), "body": .string(String(decoding: body, as: UTF8.self)),
            ]).serialized()
            let resp = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: \(json.utf8.count)\r\nconnection: close\r\n\r\n\(json)"
            c.send(content: Data(resp.utf8), completion: .contentProcessed { _ in c.cancel() })
        }
    }
}

final class RelayProxyTests: XCTestCase {
    func testForwardsHttpToUpstream() async throws {
        let up = FakeUpstream()
        let upPort = try await up.start()
        let relay = RelayServer(options: .init(upstreamBaseURL: "http://127.0.0.1:\(upPort)") { _ in })
        let port = try await relay.listen(port: 0)
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/workspaces/abc?x=1")!)
        req.httpMethod = "POST"
        req.httpBody = Data("hello".utf8)
        let (data, resp) = try await URLSession.shared.data(for: req)
        await relay.close(); up.stop()
        XCTAssertEqual((resp as? HTTPURLResponse)?.statusCode, 200)
        let j = try XCTUnwrap(RelayJSON.parse(data))
        XCTAssertEqual(j["method"]?.stringValue, "POST")
        XCTAssertEqual(j["path"]?.stringValue, "/workspaces/abc?x=1")
        XCTAssertEqual(j["body"]?.stringValue, "hello")
        XCTAssertEqual(j["host"]?.stringValue, "127.0.0.1:\(upPort)")  // Host rewritten
    }

    func testTunnelsNonRelayWebSocketToUpstream() async throws {
        let up = FakeUpstream()
        let upPort = try await up.start()
        let relay = RelayServer(options: .init(upstreamBaseURL: "http://127.0.0.1:\(upPort)") { _ in })
        let port = try await relay.listen(port: 0)
        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)/direct/mws")!)
        task.resume()
        try await task.send(.string("ping"))
        let msg = try await task.receive()
        task.cancel(with: .goingAway, reason: nil)
        await relay.close(); up.stop()
        guard case .string(let s) = msg else { return XCTFail("not text") }
        XCTAssertEqual(s, "echo:ping")
    }
}
