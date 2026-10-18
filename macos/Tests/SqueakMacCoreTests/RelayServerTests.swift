import XCTest

@testable import SqueakMacCore

/// Fake Conductor host: connects to the Swift RelayServer over a loopback
/// WebSocket and answers using RelayHostSession (the host half of the crypto).
final class FakeHost: @unchecked Sendable {
    let session = RelayHostSession()
    private let lock = NSLock()
    private var task: URLSessionWebSocketTask?
    private var connId = ""
    private(set) var sent: [RelayJSON] = []

    func connect(port: UInt16) {
        let t = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)/desktop-relay/v1/host?hostId=x&accessToken=y")!)
        lock.withLock { task = t }
        t.resume()
        receive(t)
    }

    func stop() { lock.withLock { task }?.cancel(with: .goingAway, reason: nil) }

    var delivered: [RelayJSON] { lock.withLock { sent } }

    private func sendData(_ t: URLSessionWebSocketTask, _ frame: RelayJSON) {
        let env = RelayJSON.obj(["type": "data", "connId": .string(connId), "data": .string(frame.serialized())])
        t.send(.string(env.serialized())) { _ in }
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [self] result in
            guard case .success(.string(let text)) = result, let env = RelayJSON.parse(text) else { return }
            if env["type"]?.stringValue == "open" {
                connId = env["connId"]?.stringValue ?? ""
            } else if env["type"]?.stringValue == "data", let d = env["data"]?.stringValue, let frame = RelayJSON.parse(d) {
                handle(t, frame)
            }
            receive(t)
        }
    }

    private func handle(_ t: URLSessionWebSocketTask, _ frame: RelayJSON) {
        if frame["t"]?.stringValue == "hello" {
            if let ready = try? session.ready(hello: frame) { sendData(t, ready) }
            return
        }
        guard let msg = try? session.decrypt(frame) else { return }
        func reply(_ m: RelayJSON) { if let f = try? session.encrypt(m) { sendData(t, f.json) } }
        switch msg["type"]?.stringValue {
        case "pair": reply(.obj(["type": "paired", "deviceId": "dev-1", "deviceToken": "tok-1"]))
        case "auth": reply(.obj(["type": "authOk"]))
        case "request":
            let id = msg["id"]?.stringValue ?? ""
            let target = msg["target"]?.stringValue ?? ""
            var body = "{}"
            if msg["method"]?.stringValue == "GET", target.hasSuffix("/pending-messages") {
                body = "{\"generation\":7,\"messages\":[]}"
            } else if target.hasSuffix("/pending-messages/send"), let d = msg["body"]?["data"]?.stringValue,
                let parsed = RelayJSON.parse(d)
            {
                lock.withLock { sent.append(parsed) }
            }
            reply(.obj(["type": "responseHead", "id": .string(id), "status": 200, "headers": .obj([:])]))
            reply(.obj(["type": "responseBody", "id": .string(id), "body": .obj(["encoding": "utf8", "data": .string(body)]), "final": true]))
        default: break
        }
    }
}

final class RelayServerTests: XCTestCase {
    func testPairAndSendChatMessageEndToEnd() async throws {
        let host = FakeHost()
        let result = ResultBox()
        let server = RelayServer(options: .init(hostStaticPublicKey: host.session.staticKey.publicKey) { conn in
            do {
                try await conn.client.handshake()
                let creds = try await conn.client.pair(pairingToken: "tok", deviceName: "Squeak")
                try await conn.client.authenticate(creds)
                let r = try await conn.client.sendChatMessage(workspaceLocalId: "ws 1", sessionId: "s-1", text: "hello \"squeak\"")
                result.set(creds, r.status)
            } catch { result.fail("\(error)") }
        })
        let port = try await server.listen(port: 0)
        XCTAssertNotEqual(port, 8788)
        host.connect(port: port)
        let done = await waitUntil { result.isDone }
        host.stop()
        await server.close()
        XCTAssertTrue(done)
        XCTAssertNil(result.error)
        XCTAssertEqual(result.creds, DeviceCredentials(deviceId: "dev-1", deviceToken: "tok-1"))
        XCTAssertEqual(result.status, 200)
        let sent = host.delivered
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?["deliveryPayload"]?["message"]?.stringValue, "hello \"squeak\"")
        XCTAssertEqual(sent.first?["expectedGeneration"]?.intValue, 7)
        XCTAssertEqual(sent.first?["mode"]?.stringValue, "queue")
    }

    func testAuthExchangeAnsweredInOfflineMode() async throws {
        let server = RelayServer(options: .init { _ in })
        let port = try await server.listen(port: 0)
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/auth/exchange")!)
        req.httpMethod = "POST"
        let (data, resp) = try await URLSession.shared.data(for: req)
        await server.close()
        XCTAssertEqual((resp as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertNotNil(RelayJSON.parse(data)?["accessToken"]?.stringValue)
    }

    func testRefusesNonLoopbackBind() async {
        let server = RelayServer(options: .init { _ in })
        do { _ = try await server.listen(port: 0, host: "0.0.0.0"); XCTFail("bound") } catch {}
    }

    func testServiceInertWhenNotConfigured() async {
        for cfg in [
            RelayService.Config(overrideURL: nil, credentials: nil),
            RelayService.Config(overrideURL: "https://api.conductor.build", credentials: .init(deviceId: "d", deviceToken: "t")),
            RelayService.Config(overrideURL: "http://127.0.0.1:0", credentials: nil),
        ] {
            let svc = RelayService(config: cfg, hostKeyStore: InMemoryRelayHostKeyStore())
            svc.start()
            XCTAssertFalse(svc.isReady)
            XCTAssertNil(svc.boundPort)
            let r = await svc.send(workspaceId: "w", sessionId: "s", text: "hi")
            XCTAssertEqual(r, .failed(reason: "relay not connected"))
            await svc.stop()
        }
    }

    func testServiceAuthenticatesAndSends() async throws {
        let host = FakeHost()
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("relay-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = FileRelayHostKeyStore(directory: dir)
        let svc = RelayService(
            config: .init(overrideURL: "http://127.0.0.1:0", credentials: .init(deviceId: "dev-1", deviceToken: "tok-1"), upstreamBaseURL: nil, listenRetryInterval: 0.1),
            hostKeyStore: store)
        svc.start()
        let up = await waitUntil { svc.boundPort != nil }
        XCTAssertTrue(up)
        host.connect(port: try XCTUnwrap(svc.boundPort))
        let ready = await waitUntil { svc.isReady }
        XCTAssertTrue(ready)
        let r = await svc.send(workspaceId: "w", sessionId: "s", text: "hi")
        XCTAssertEqual(r, .ok)
        XCTAssertEqual(store.load(), host.session.staticKey.publicKey)  // TOFU persisted
        host.stop()
        await svc.stop()
    }
}

final class ResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _creds: DeviceCredentials?, _status: Int?, _error: String?
    func set(_ c: DeviceCredentials, _ s: Int) { lock.withLock { _creds = c; _status = s } }
    func fail(_ e: String) { lock.withLock { _error = e } }
    var isDone: Bool { lock.withLock { _status != nil || _error != nil } }
    var creds: DeviceCredentials? { lock.withLock { _creds } }
    var status: Int? { lock.withLock { _status } }
    var error: String? { lock.withLock { _error } }
}
