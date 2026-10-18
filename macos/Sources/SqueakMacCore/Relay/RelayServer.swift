import Foundation
import Network

/// One host connection handed to `onHost`: the phone-side client plus a way to hang up.
public final class RelayHostConnection: Sendable {
    public let client: PhoneClient
    private let closer: @Sendable (String) -> Void
    init(client: PhoneClient, closer: @escaping @Sendable (String) -> Void) {
        self.client = client
        self.closer = closer
    }
    public func close(reason: String = "done") { closer(reason) }
}

/// The local stand-in for Conductor's cloud desktop relay (`relay-server.ts`).
/// Conductor's host dials `ws://127.0.0.1:<port>/desktop-relay/v1/host`; we accept
/// it and play the phone. Everything else is either forwarded to the upstream
/// (production) or, with no upstream, answered with a throwaway `/auth/exchange`
/// token and 503 (offline-test mode).
///
/// Loopback only: `listen` refuses any host other than 127.0.0.1.
public final class RelayServer: @unchecked Sendable {
    public static let relayPath = "/desktop-relay/v1/host"

    public struct Options: Sendable {
        /// Pins the Mac's static key; nil trusts the key presented on first connect.
        public var hostStaticPublicKey: Data?
        /// Where non-relay traffic goes; nil is offline-test mode.
        public var upstreamBaseURL: String?
        public var onHost: @Sendable (RelayHostConnection) async -> Void

        public init(
            hostStaticPublicKey: Data? = nil, upstreamBaseURL: String? = nil,
            onHost: @escaping @Sendable (RelayHostConnection) async -> Void
        ) {
            self.hostStaticPublicKey = hostStaticPublicKey
            self.upstreamBaseURL = upstreamBaseURL
            self.onHost = onHost
        }
    }

    private let options: Options
    private let queue = DispatchQueue(label: "squeak.relay.server")
    private let proxy: RelayUpstreamProxy?
    private let lock = NSLock()
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: NWConnection] = [:]

    public init(options: Options) {
        self.options = options
        self.proxy = options.upstreamBaseURL.flatMap { RelayUpstreamProxy(upstreamBaseURL: $0, queue: DispatchQueue(label: "squeak.relay.proxy")) }
    }

    /// Bind 127.0.0.1:`port` (0 = ephemeral) and return the bound port. Throws if the bind fails.
    public func listen(port: UInt16, host: String = "127.0.0.1") async throws -> UInt16 {
        guard host == "127.0.0.1" else { throw RelayError("relay server only binds 127.0.0.1") }
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: port) ?? .any)
        let listener = try NWListener(using: params)
        listener.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        let once = OnceFlag()
        let bound: UInt16 = try await withCheckedThrowingContinuation { (c: CheckedContinuation<UInt16, Error>) in
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if once.fire() { c.resume(returning: listener.port?.rawValue ?? port) }
                case .failed(let e):
                    if once.fire() { c.resume(throwing: e) }
                case .cancelled:
                    if once.fire() { c.resume(throwing: RelayError("relay listener cancelled")) }
                default: break
                }
            }
            listener.start(queue: queue)
        }
        lock.withLock { self.listener = listener }
        return bound
    }

    public func close() async {
        let (l, conns): (NWListener?, [NWConnection]) = lock.withLock {
            let l = listener
            listener = nil
            let conns = Array(connections.values)
            connections.removeAll()
            return (l, conns)
        }
        l?.cancel()
        for c in conns { c.cancel() }
        // Give the listener a beat to release the port before a caller rebinds it.
        if l != nil { try? await Task.sleep(nanoseconds: 50_000_000) }
    }

    // MARK: connections

    private func accept(_ conn: NWConnection) {
        let id = ObjectIdentifier(conn)
        lock.lock(); connections[id] = conn; lock.unlock()
        conn.stateUpdateHandler = { [weak self] state in
            if case .cancelled = state {
                self?.lock.lock(); self?.connections[id] = nil; self?.lock.unlock()
            }
        }
        conn.start(queue: queue)
        readHead(conn, buffer: Data())
    }

    private static let maxHead = 64 * 1024

    private func readHead(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [self] data, _, isComplete, error in
            var buf = buffer
            if let data { buf.append(data) }
            if let range = buf.range(of: RelayHTTPHead.terminator) {
                let headData = buf.subdata(in: buf.startIndex..<range.lowerBound)
                let leftover = buf.subdata(in: range.upperBound..<buf.endIndex)
                guard let head = RelayHTTPHead.parse(headData) else { conn.cancel(); return }
                route(conn, head: head, leftover: leftover)
            } else if error != nil || isComplete || buf.count > Self.maxHead {
                conn.cancel()
            } else {
                readHead(conn, buffer: buf)
            }
        }
    }

    private func route(_ conn: NWConnection, head: RelayHTTPHead, leftover: Data) {
        if head.isWebSocketUpgrade, head.path == Self.relayPath {
            guard let key = head.header("sec-websocket-key") else {
                respond(conn, status: "400 Bad Request", body: "{\"error\":\"missing Sec-WebSocket-Key\"}")
                return
            }
            let handshake =
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(RelayWS.acceptKey(key))\r\n\r\n"
            conn.send(content: Data(handshake.utf8), completion: .contentProcessed { [self] error in
                if error != nil { conn.cancel(); return }
                handleHostConnection(RelayWebSocketConnection(connection: conn, initial: leftover))
            })
            return
        }
        if let proxy {
            proxy.handle(client: conn, head: head, leftover: leftover, isUpgrade: head.isWebSocketUpgrade)
            return
        }
        if head.isWebSocketUpgrade {
            respond(conn, status: "404 Not Found", body: "")
            return
        }
        if head.method == "POST", head.path == "/auth/exchange" {
            let expires = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))
            let body = RelayJSON.obj([
                "accessToken": "squeak-local-relay",
                "accessTokenExpiresAt": .string(expires),
                "refreshToken": "squeak-local-relay",
            ]).serialized()
            respond(conn, status: "200 OK", body: body)
            return
        }
        respond(conn, status: "503 Service Unavailable", body: "{\"error\":\"not handled by local relay\"}")
    }

    private func respond(_ conn: NWConnection, status: String, body: String) {
        let resp =
            "HTTP/1.1 \(status)\r\ncontent-type: application/json\r\ncontent-length: \(body.utf8.count)\r\nconnection: close\r\n\r\n\(body)"
        conn.send(content: Data(resp.utf8), completion: .contentProcessed { _ in conn.cancel() })
    }

    private func handleHostConnection(_ ws: RelayWebSocketConnection) {
        let connId = String(UInt64.random(in: 0...UInt64.max), radix: 36) + String(UInt64(Date().timeIntervalSince1970 * 1000), radix: 36)
        let closeConn: @Sendable (String) -> Void = { reason in
            ws.sendText(RelayJSON.obj(["type": "close", "connId": .string(connId)]).serialized())
            ws.close(code: 1000, reason: reason)
        }
        final class Transport: PhoneTransport {
            let ws: RelayWebSocketConnection
            let connId: String
            let closer: @Sendable (String) -> Void
            init(ws: RelayWebSocketConnection, connId: String, closer: @escaping @Sendable (String) -> Void) {
                self.ws = ws; self.connId = connId; self.closer = closer
            }
            func send(frame: RelayJSON) {
                ws.sendText(RelayJSON.obj(["type": "data", "connId": .string(connId), "data": .string(frame.serialized())]).serialized())
            }
            func close(reason: String) { closer(reason) }
        }
        let client = PhoneClient(
            transport: Transport(ws: ws, connId: connId, closer: closeConn),
            expectedHostStaticKey: options.hostStaticPublicKey)

        ws.onText { text in
            guard let env = RelayJSON.parse(text) else { return }
            if let id = env["connId"]?.stringValue, id != connId { return }
            switch env["type"]?.stringValue {
            case "data":
                if let data = env["data"]?.stringValue { client.handleData(data) }
            case "close":
                client.handleClose()
            default: break
            }
        }
        ws.onClose { _, _ in client.handleClose() }
        ws.start()

        // Bring the phone up: announce the connection; the caller starts the handshake.
        ws.sendText(RelayJSON.obj(["type": "open", "connId": .string(connId)]).serialized())
        let onHost = options.onHost
        let host = RelayHostConnection(client: client, closer: closeConn)
        Task { await onHost(host) }
    }
}

final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false
    func fire() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if fired { return false }
        fired = true
        return true
    }
}
