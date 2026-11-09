import Foundation
import Network

/// Transparent pass-through to Conductor's real cloud backend (`proxy.ts`).
/// `roundhouse_client_url_override` is one global base URL, so pointing it here
/// sends all of Conductor's cloud traffic through us; everything except the
/// relay WebSocket is replayed upstream byte for byte (no frame parsing, no
/// MITM). Plain HTTP is replayed with `Host` fixed and `Connection: close`, so
/// the response can be piped back until the upstream hangs up.
final class RelayUpstreamProxy: @unchecked Sendable {
    private let host: String
    private let port: UInt16
    private let isTLS: Bool
    private let hostHeader: String
    private let queue: DispatchQueue

    init?(upstreamBaseURL: String, queue: DispatchQueue) {
        guard let url = URL(string: upstreamBaseURL), let host = url.host, let scheme = url.scheme else { return nil }
        self.host = host
        self.isTLS = scheme == "https"
        self.port = UInt16(url.port ?? (isTLS ? 443 : 80))
        self.hostHeader = url.port.map { "\(host):\($0)" } ?? host
        self.queue = queue
    }

    /// Take over `client`: replay `head` (+ any bytes already read past it) upstream and pipe both ways.
    func handle(client: NWConnection, head: RelayHTTPHead, leftover: Data, isUpgrade: Bool) {
        var lines = ["\(head.method) \(head.target) HTTP/1.1", "Host: \(hostHeader)"]
        for h in head.headers {
            let n = h.name.lowercased()
            if n == "host" { continue }
            if !isUpgrade, n == "connection" || n == "proxy-connection" || n == "keep-alive" { continue }
            lines.append("\(h.name): \(h.value)")
        }
        if !isUpgrade { lines.append("Connection: close") }
        let replay = Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8) + leftover

        let params: NWParameters = isTLS ? .tls : .tcp
        let upstream = NWConnection(
            host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port)!, using: params)
        let tunnel = Tunnel(client: client, upstream: upstream, isUpgrade: isUpgrade)
        upstream.stateUpdateHandler = { state in
            switch state {
            case .ready: tunnel.upstreamReady(replay: replay)
            case .failed, .cancelled: tunnel.upstreamFailed()
            default: break
            }
        }
        upstream.start(queue: queue)
    }
}

private final class Tunnel: @unchecked Sendable {
    let client: NWConnection
    let upstream: NWConnection
    let isUpgrade: Bool
    private let lock = NSLock()
    private var finished = 0
    private var sentToClient = false
    private var dead = false

    init(client: NWConnection, upstream: NWConnection, isUpgrade: Bool) {
        self.client = client
        self.upstream = upstream
        self.isUpgrade = isUpgrade
    }

    func upstreamReady(replay: Data) {
        upstream.send(content: replay, completion: .contentProcessed { [self] error in
            if error != nil { teardown(); return }
            pump(from: client, to: upstream, towardClient: false)
            pump(from: upstream, to: client, towardClient: true)
        })
    }

    func upstreamFailed() {
        lock.lock()
        let already = sentToClient || dead
        lock.unlock()
        if !already {
            let body = "{\"error\":\"upstream request failed\"}"
            let resp = "HTTP/1.1 502 Bad Gateway\r\ncontent-type: application/json\r\ncontent-length: \(body.utf8.count)\r\nconnection: close\r\n\r\n\(body)"
            client.send(content: Data(resp.utf8), completion: .contentProcessed { [self] _ in teardown() })
        } else {
            teardown()
        }
    }

    private func teardown() {
        lock.lock()
        if dead { lock.unlock(); return }
        dead = true
        lock.unlock()
        client.cancel()
        upstream.cancel()
    }

    private func pump(from src: NWConnection, to dst: NWConnection, towardClient: Bool) {
        src.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [self] data, _, isComplete, error in
            if error != nil { teardown(); return }
            let finish: @Sendable () -> Void = {
                // Half-close: tell the other side this direction is done.
                dst.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { [self] _ in
                    lock.lock()
                    finished += 1
                    let both = finished >= 2
                    lock.unlock()
                    // A plain HTTP exchange ends when the upstream is done.
                    if both || (towardClient && !isUpgrade) { teardown() }
                })
            }
            if let data, !data.isEmpty {
                if towardClient { lock.lock(); sentToClient = true; lock.unlock() }
                dst.send(content: data, completion: .contentProcessed { [self] e in
                    if e != nil { teardown(); return }
                    if isComplete { finish() } else { pump(from: src, to: dst, towardClient: towardClient) }
                })
            } else if isComplete {
                finish()
            } else {
                pump(from: src, to: dst, towardClient: towardClient)
            }
        }
    }
}
