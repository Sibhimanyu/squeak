import Foundation
import CryptoKit

/* Catalyst as the channel's cloud store (docs/cloud-layer.md, spikes/catalyst/README.md): documents go through the
   relay function over HTTP; changes arrive as "something changed" notices on ONE Data Streams WebSocket. */

/// One WebSocket, as the client needs it; injectable so reconnects are testable.
public protocol WebSocketConnection: Sendable {
    func send(_ text: String) async throws
    /// The next text frame; nil when the peer closed.
    func receive() async throws -> String?
    func close()
}

public protocol WebSocketTransport: Sendable {
    func connect(_ url: URL) -> WebSocketConnection
}

/// The real thing, on a session of its own (one socket for the whole client: iOS allows few connections per host).
public final class URLSessionWebSockets: WebSocketTransport, @unchecked Sendable {
    private let session: URLSession
    public init(session: URLSession = Channel.streamSession) { self.session = session }

    public func connect(_ url: URL) -> WebSocketConnection {
        let task = session.webSocketTask(with: url)
        task.resume()
        return Socket(task: task)
    }

    private final class Socket: WebSocketConnection, @unchecked Sendable {
        let task: URLSessionWebSocketTask
        init(task: URLSessionWebSocketTask) { self.task = task }
        func send(_ text: String) async throws { try await task.send(.string(text)) }
        func receive() async throws -> String? {
            while true {
                switch try await task.receive() {
                case .string(let text): return text
                case .data: continue
                @unknown default: continue
                }
            }
        }
        func close() { task.cancel(with: .normalClosure, reason: nil) }
    }
}

/// Intervals of the Data Streams client (the JS client's own: `-` every 15 s, a ping every 60 s); tests shorten them.
public struct CatalystTiming: Sendable {
    public var keepAlive: Double = 15
    public var ping: Double = 60
    /// While watching, everything is told to re-read this often. A notice carries the news and a (re)connect re-reads
    /// at once, so this is only the net under a lost notice: 5 minutes, not the Realtime Database's 60 s.
    public var safetyPoll: Double = 300
    public var retryMin: Double = 1
    public var retryMax: Double = 10
    /// Nothing heard for this long (a pong comes back to every ping) is a half-open socket: reconnect.
    public var stall: Double = 75
    public init() {}
    public static let standard = CatalystTiming()
}

public struct CatalystClient: CloudStore {
    public enum Failure: Error, Equatable { case http(Int), badToken, badHost, authFailed, closed }

    let base: String
    let key: String
    let transport: HTTPTransport
    let hub: CatalystHub

    public init(relayURL: String, relayKey: String, channel: String? = nil, transport: HTTPTransport = URLSession.shared,
                sockets: WebSocketTransport = URLSessionWebSockets(), timing: CatalystTiming = .standard) {
        var root = relayURL
        while root.hasSuffix("/") { root.removeLast() }
        base = root
        key = relayKey
        self.transport = transport
        let (base, key) = (root, relayKey)
        hub = CatalystHub(sockets: sockets, timing: timing) {
            try await Self.token(base: base, key: key, channel: channel, transport: transport)
        }
    }

    /* ---------- the relay ---------- */

    static let relayHeader = "x-squeak-relay"

    static func encode(_ text: String) -> String {
        text.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_"))) ?? text
    }

    func request(_ method: String, _ route: String, body: Data? = nil) -> URLRequest {
        var request = URLRequest(url: URL(string: base + route)!)
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue(key, forHTTPHeaderField: Self.relayHeader)
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        return request
    }

    public func get(_ path: String) async throws -> ChannelDocument? {
        let (data, response) = try await transport.data(for: request("GET", "/doc?path=" + Self.encode(path)))
        let status = Self.status(response)
        if status == 404 || status == 204 { return nil }
        guard (200..<300).contains(status) else { throw Failure.http(status) }
        return Self.document(in: data)
    }

    public func set(_ path: String, _ document: ChannelDocument) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["doc": RealtimeDatabaseClient.encoded(document)])
        let (_, response) = try await transport.data(for: request("PUT", "/doc?path=" + Self.encode(path), body: body))
        let status = Self.status(response)
        guard (200..<300).contains(status) else { throw Failure.http(status) }
    }

    public func delete(_ path: String) async throws {
        let (_, response) = try await transport.data(for: request("DELETE", "/doc?path=" + Self.encode(path)))
        let status = Self.status(response)
        // A missing document is fine.
        guard (200..<300).contains(status) || status == 404 else { throw Failure.http(status) }
    }

    public func list(_ collection: String) async throws -> [CloudListing] {
        let (data, response) = try await transport.data(for: request("GET", "/list?prefix=" + Self.encode(collection)))
        let status = Self.status(response)
        if status == 404 { return [] }
        guard (200..<300).contains(status) else { throw Failure.http(status) }
        guard let json = try JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed) as? [String: Any],
              let items = json["items"] as? [[String: Any]] else { return [] }
        return items.compactMap { item in
            guard let id = item["id"] as? String, let doc = Self.document(from: item["doc"]) else { return nil }
            return CloudListing(id: id, doc: doc)
        }
    }

    static func status(_ response: URLResponse) -> Int { (response as? HTTPURLResponse)?.statusCode ?? 0 }

    /// `{doc}` where doc is the document object (or its JSON as a string); null or absent is no document.
    static func document(in data: Data) -> ChannelDocument? {
        guard let json = try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed) as? [String: Any] else { return nil }
        return document(from: json["doc"])
    }

    static func document(from value: Any?) -> ChannelDocument? {
        if let object = value as? [String: Any] { return RealtimeDatabaseClient.decoded(object) }
        if let text = value as? String,
           let object = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] {
            return RealtimeDatabaseClient.decoded(object)
        }
        return nil
    }

    /* ---------- Data Streams ---------- */

    struct Token: Equatable, Sendable { let host: String; let wssId: String; let key: String }

    /// Where a Data Streams server may be: the JS client's own allow-list (`<dc><n>-dms.zoho.<tld>`).
    static func isStreamsHost(_ host: String) -> Bool {
        host.range(of: #"^[a-z]{2}[0-9]{1,2}-dms\.zoho\.(com|in|eu|com\.au|jp|ca|sa)$"#, options: .regularExpression) != nil
    }

    /// `channel` (the Mac's channel id) asks the relay for that channel's own stream; a relay without one answers with the shared stream.
    static func token(base: String, key: String, channel: String? = nil, transport: HTTPTransport) async throws -> Token {
        let name = "p" + String((0..<12).map { _ in "abcdefghijklmnopqrstuvwxyz0123456789".randomElement()! })
        var request = URLRequest(url: URL(string: base + "/token")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue(key, forHTTPHeaderField: relayHeader)
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        var body: [String: String] = ["name": name]
        if let channel { body["channel"] = channel }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await transport.data(for: request)
        let status = Self.status(response)
        guard (200..<300).contains(status) else { throw Failure.http(status) }
        guard var json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw Failure.badToken }
        if let nested = json["token"] as? [String: Any] { json = nested }
        guard var host = (json["url"] as? String)?.lowercased(),
              let key = json["key"] as? String,
              let wssId = (json["wssId"] ?? json["wss-id"]) as? String, !key.isEmpty, !wssId.isEmpty
        else { throw Failure.badToken }
        if host.hasPrefix("wss://") { host.removeFirst(6) }
        while host.hasSuffix("/") { host.removeLast() }
        guard isStreamsHost(host) else { throw Failure.badHost }
        return Token(host: host, wssId: wssId, key: key)
    }

    static func connectURL(host: String, wssId: String?, key: String, resume: (sid: String?, uid: String?)? = nil) -> URL {
        var components = URLComponents()
        components.scheme = "wss"
        components.host = host
        components.path = "/wsconnect"
        var items = [URLQueryItem(name: "prd", value: "CY")]
        if let wssId { items.append(URLQueryItem(name: "zuid", value: wssId)) }
        items.append(URLQueryItem(name: "key", value: key))
        if let resume {
            if let sid = resume.sid { items.append(URLQueryItem(name: "i", value: sid)) }
            if let uid = resume.uid { items.append(URLQueryItem(name: "c", value: uid)) }
        }
        components.queryItems = items
        return components.url!
    }

    /// Whether a notice for the collection `notice` concerns a watch on `path`: the same place, a parent of it, or a
    /// document inside it.
    static func related(watch path: String, notice: String) -> Bool {
        path == notice || notice.hasPrefix(path + "/") || path.hasPrefix(notice + "/")
    }

    /// base64url(SHA-256("squeak-notice-v1:" + channelId)), first 22 characters; mirrors the relay's `noticeTag`.
    static func noticeTag(_ channelId: String) -> String {
        let digest = SHA256.hash(data: Data(("squeak-notice-v1:" + channelId).utf8))
        let b64 = Data(digest).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return String(b64.prefix(22))
    }

    /// The channel id inside a watched path ("channels/<id>/..."), or nil.
    static func channel(ofPath path: String) -> String? {
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        return parts.count >= 2 && parts[0] == "channels" ? String(parts[1]) : nil
    }

    /// Yields once per notice (and on connect / re-read requests), like the Realtime Database's stream.
    public func changes(_ path: String) -> AsyncStream<Void>? {
        let hub = hub
        return AsyncStream { continuation in
            let task = Task {
                for await event in await hub.subscribe(path) {
                    switch event {
                    case .connected, .change, .resync: continuation.yield(())
                    default: break
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// A notice names a collection, not a document, so the document is read again and yielded whole.
    public func documents(_ path: String) -> AsyncStream<DocumentChange>? {
        let hub = hub
        return AsyncStream { continuation in
            let gate = ReadGate()
            let task = Task {
                for await event in await hub.subscribe(path) {
                    switch event {
                    case .connected, .change, .resync:
                        Task {
                            await gate.run {
                                do { continuation.yield(.value(try await get(path))) } catch { continuation.yield(.refetch) }
                            }
                        }
                    default: break
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// One `list` per change tells every watched document of the collection its new value.
    public func events(in collection: String, documents names: [String]) -> AsyncStream<ChannelEvent>? {
        let hub = hub
        return AsyncStream { continuation in
            let gate = ReadGate()
            let task = Task {
                for await event in await hub.subscribe(collection) {
                    switch event {
                    case .dropped: continuation.yield(.dropped)
                    case .keepAlive: continuation.yield(.heard)
                    case .connected, .resync, .change:
                        if case .connected = event { continuation.yield(.connected) }
                        continuation.yield(.heard)
                        Task {
                            await gate.run {
                                do {
                                    let items = Dictionary(try await list(collection).map { ($0.id, $0.doc) }, uniquingKeysWith: { _, last in last })
                                    for name in names { continuation.yield(.document(name, .value(items[name]))) }
                                } catch {
                                    for name in names { continuation.yield(.document(name, .refetch)) }
                                }
                            }
                        }
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func streamHealth() async -> [StreamHealth] { await hub.health() }
}

/// Runs reads one at a time; a request that arrives meanwhile becomes one more run after it, however many arrive.
actor ReadGate {
    private var running = false
    private var again = false

    func run(_ work: @Sendable () async -> Void) async {
        if running { again = true; return }
        running = true
        repeat {
            again = false
            await work()
        } while again
        running = false
    }
}

/// The client's one Data Streams socket, fanned out by path prefix. Starts with the first listener, stops with the last.
actor CatalystHub {
    private struct Listener { let path: String; let continuation: AsyncStream<StreamEvent>.Continuation }
    private var listeners: [UUID: Listener] = [:]
    private var runner: Task<Void, Never>?
    private var stats = StreamHealth(path: "catalyst")

    private let sockets: WebSocketTransport
    private let timing: CatalystTiming
    private let tokens: @Sendable () async throws -> CatalystClient.Token

    // The live session's state (one at a time).
    private var sid: String?
    private var uid: String?
    private var subscribed = false
    private var opened = false

    init(sockets: WebSocketTransport, timing: CatalystTiming, tokens: @escaping @Sendable () async throws -> CatalystClient.Token) {
        self.sockets = sockets
        self.timing = timing
        self.tokens = tokens
    }

    func subscribe(_ path: String) -> AsyncStream<StreamEvent> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<StreamEvent>.makeStream(bufferingPolicy: .bufferingNewest(64))
        continuation.onTermination = { [weak self] _ in Task { await self?.leave(id) } }
        listeners[id] = Listener(path: path, continuation: continuation)
        stats.listeners = listeners.count
        if runner == nil {
            runner = Task { [weak self] in await self?.run() }
        } else if stats.connected {
            continuation.yield(.resync)
        }
        return stream
    }

    func health() -> [StreamHealth] { [stats] }

    private func leave(_ id: UUID) {
        listeners[id] = nil
        stats.listeners = listeners.count
        if listeners.isEmpty {
            runner?.cancel()
            runner = nil
            stats.connected = false
        }
    }

    private func emit(_ event: StreamEvent) {
        for listener in listeners.values { listener.continuation.yield(event) }
    }

    private func touch() { stats.lastEventAt = Date(); lastHeard = Date() }
    private var lastHeard = Date()

    /* ---------- the connection loop ---------- */

    private enum Outcome { case switchHost(host: String, sid: String?, uid: String?) }

    private func run() async {
        let poll = Task { [weak self, timing] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(timing.safetyPoll))
                if Task.isCancelled { break }
                await self?.emit(.resync)
            }
        }
        defer { poll.cancel() }
        var retry = timing.retryMin
        var reuse: CatalystClient.Token?
        var hop: (host: String, sid: String?, uid: String?)?
        while !Task.isCancelled {
            do {
                // A fresh token (and connection name) for every connection, except when the server sent us elsewhere.
                let token: CatalystClient.Token
                if let reuse { token = reuse } else { token = try await tokens() }
                reuse = nil
                let host = hop?.host ?? token.host
                guard CatalystClient.isStreamsHost(host) else { throw CatalystClient.Failure.badHost }
                let resume = hop.map { (sid: $0.sid, uid: $0.uid) }
                hop = nil
                let outcome = try await session(token: token, host: host, resume: resume, retry: &retry)
                if case .switchHost(let next, let sid, let uid) = outcome {
                    hop = (next, sid, uid)
                    reuse = token
                    continue
                }
            } catch {}
            if Task.isCancelled { break }
            stats.connected = false
            stats.drops += 1
            emit(.dropped)
            // 50-100% of the backoff, so phones dropped together do not come back together.
            try? await Task.sleep(for: .seconds(Self.jittered(retry)))
            retry = min(retry * 2, timing.retryMax)
        }
        stats.connected = false
    }

    /// A wait spread over 50-100% of `seconds`.
    static func jittered(_ seconds: Double, random: Double = .random(in: 0...1)) -> Double {
        seconds * (0.5 + 0.5 * random)
    }

    /// One connection. Ends by throwing (dropped, refused, closed) or by being sent to another host. Whatever the end,
    /// the session is released first: unsubscribe, then close, so the server frees the connection name.
    private func session(token: CatalystClient.Token, host: String, resume: (sid: String?, uid: String?)?, retry: inout Double) async throws -> Outcome {
        let url = CatalystClient.connectURL(host: host, wssId: resume == nil ? token.wssId : nil, key: token.key, resume: resume)
        let socket = sockets.connect(url)
        sid = nil; uid = nil; subscribed = false; opened = false
        lastHeard = Date()
        var failure: Error?
        var outcome: Outcome?
        do {
            outcome = try await withThrowingTaskGroup(of: Outcome?.self) { group in
                group.addTask { [weak self] in
                    while true {
                        guard let text = try await socket.receive() else { throw CatalystClient.Failure.closed }
                        if let outcome = try await self?.handle(text, socket: socket, token: token) { return outcome }
                    }
                }
                group.addTask { [timing] in
                    while true {
                        try await Task.sleep(for: .seconds(timing.keepAlive))
                        try await socket.send("-")
                    }
                }
                group.addTask { [timing] in
                    while true {
                        try await Task.sleep(for: .seconds(timing.ping))
                        try await socket.send(#"{"type":"con","value":"ping"}"#)
                    }
                }
                // A socket that has gone quiet (a network change leaves it half open) is dropped, as the daemon and web do.
                group.addTask { [weak self, timing] in
                    let check = max(timing.stall / 5, 0.05)
                    while true {
                        try await Task.sleep(for: .seconds(check))
                        if let last = await self?.lastHeard, Date().timeIntervalSince(last) > timing.stall {
                            throw CatalystClient.Failure.closed
                        }
                    }
                }
                defer { group.cancelAll() }
                guard let first = try await group.next() else { return nil }
                return first
            }
            if opened { retry = timing.retryMin }
        } catch {
            failure = error
        }
        let wasSubscribed = subscribed
        subscribed = false
        await Task {
            if wasSubscribed { try? await socket.send(#"{"type":"con","value":"unsubscribe"}"#) }
            socket.close()
        }.value
        if let failure { throw failure }
        guard let outcome else { throw CatalystClient.Failure.closed }
        return outcome
    }

    /// One text frame off the socket.
    private func handle(_ text: String, socket: WebSocketConnection, token: CatalystClient.Token) async throws -> Outcome? {
        touch()
        stats.bytes += text.utf8.count
        if text.isEmpty { emit(.keepAlive); return nil } // a pong
        guard let frames = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [[String: Any]] else { return nil }
        for frame in frames {
            let type: String
            if let string = frame["mtype"] as? String { type = string } else if let number = frame["mtype"] as? NSNumber { type = number.stringValue } else { continue }
            let message = frame["msg"] as? [String: Any]
            switch type {
            case "0":
                sid = message?["sid"] as? String
                uid = message?["uid"] as? String
                try await socket.send(#"{"type":"con","value":"subscribe","streamingId":"0"}"#)
                subscribed = true
                opened = true
                stats.connected = true
                stats.connectedAt = Date()
                emit(.connected)
            case "650":
                guard let message, message["opr"] as? String == "event", let data = message["data"] as? [String: Any] else { continue }
                // Every message is acknowledged, or the next is never delivered.
                if let streamingId = (data["streamingId"] as? String) ?? (data["streamingId"] as? NSNumber)?.stringValue {
                    let ack = try JSONSerialization.data(withJSONObject: ["type": "ack", "streamingId": streamingId])
                    try await socket.send(String(decoding: ack, as: UTF8.self))
                }
                notice(data["data"] as? String)
            case "-1":
                // Switch host: msg[msg.primarydc] is the new one; come back with the session ids.
                if let message, let dc = message["primarydc"] as? String, let next = (message[dc] as? String)?.lowercased(),
                   CatalystClient.isStreamsHost(next) {
                    return .switchHost(host: next, sid: sid ?? message["sid"] as? String, uid: uid ?? message["uid"] as? String)
                }
                throw CatalystClient.Failure.badHost
            case "-5", "-2": throw CatalystClient.Failure.authFailed
            case "-11", "660", "670": throw CatalystClient.Failure.closed
            default: continue
            }
        }
        return nil
    }

    private var tagCache: [String: String] = [:]

    /// The tag the hosted relay publishes for a channel (cached: the same few channels every notice).
    private func tag(of channel: String) -> String {
        if let cached = tagCache[channel] { return cached }
        let value = CatalystClient.noticeTag(channel)
        tagCache[channel] = value
        return value
    }

    /// `{"p":"channels/<id>/<kind>"}` (self-hosted) or `{"t":"<tag>"}` (the shared hosted channel: the channel only,
    /// not the kind, so every listener of the matching channel wakes). Anything else is a reason to re-read everything.
    /// Only wakes listeners; the notice's data is never acted on.
    private func notice(_ data: String?) {
        guard let data, let json = (try? JSONSerialization.jsonObject(with: Data(data.utf8))) as? [String: Any] else { return emit(.resync) }
        // A phone's own presence ping (and any other phone's) is not news to a phone: only the Mac reads it. `k` is the
        // relay's optional name of the state document written; an older relay sends none and wakes as before.
        if json["k"] as? String == "presence" { return }
        if let path = json["p"] as? String {
            for listener in listeners.values where CatalystClient.related(watch: listener.path, notice: path) {
                listener.continuation.yield(.change(name: "notice", data: path))
            }
            return
        }
        guard let t = json["t"] as? String else { return emit(.resync) }
        for listener in listeners.values {
            // A watch outside a channel path cannot be matched, so it wakes: waking too much costs a read.
            if let channel = CatalystClient.channel(ofPath: listener.path), tag(of: channel) != t { continue }
            listener.continuation.yield(.change(name: "notice", data: t))
        }
    }
}
