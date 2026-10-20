import Foundation

/// Where the channel's documents live: Firestore (the original) or the
/// Realtime Database. Both store the same `{ box, sig?, device?, at? }`.
public protocol ChannelBackend: Sendable {
    func get(_ path: String) async throws -> ChannelDocument?
    func set(_ path: String, _ document: ChannelDocument) async throws
    func delete(_ path: String) async throws
    /// Yields whenever anything at or under `path` changes, or nil when this
    /// backend cannot stream (Firestore over REST), in which case poll.
    func changes(_ path: String) -> AsyncStream<Void>?
    /// Like `changes`, for one document, carrying its new value when the
    /// event has it, so the caller does not download it a second time.
    func documents(_ path: String) -> AsyncStream<DocumentChange>?
    /// Several documents of one collection over a single stream, with the
    /// stream's own health; nil when this backend cannot stream.
    func events(in collection: String, documents names: [String]) -> AsyncStream<ChannelEvent>?
    /// Each open stream's health, for the phone's connection details.
    func streamHealth() async -> [StreamHealth]
}

/// What one stream on a collection says: it (re)connected, it dropped, the
/// server was heard from (any event, keep-alives included), or one of the
/// watched documents changed.
public enum ChannelEvent: Equatable, Sendable {
    case connected
    case dropped
    case heard
    case document(String, DocumentChange)
}

/// One event on a document's stream: its whole new value (nil: deleted), or
/// a partial change the caller must re-read.
public enum DocumentChange: Equatable, Sendable {
    case value(ChannelDocument?)
    case refetch
}

extension FirestoreClient: ChannelBackend {
    public func changes(_ path: String) -> AsyncStream<Void>? { nil }
    public func documents(_ path: String) -> AsyncStream<DocumentChange>? { nil }
    public func events(in collection: String, documents names: [String]) -> AsyncStream<ChannelEvent>? { nil }
    public func streamHealth() async -> [StreamHealth] { [] }
}

/// One raw event off a Server-Sent Events stream.
public enum StreamEvent: Equatable, Sendable {
    /// The stream opened (or reopened).
    case connected
    /// A `put` or `patch`, with its data line (nil when it came without one).
    case change(name: String, data: String?)
    /// "You may have missed something": a listener joined a stream already
    /// open, so it never saw the value sent on connect. Re-read.
    case resync
    case keepAlive
    /// The connection ended or failed; it is retried by itself.
    case dropped
}

/// How one shared stream is doing.
public struct StreamHealth: Equatable, Sendable {
    public let path: String
    public var connected = false
    public var connectedAt: Date?
    public var lastEventAt: Date?
    /// Times it dropped since it was opened.
    public var drops = 0
    /// Characters of event data received: roughly the bytes downloaded.
    public var bytes = 0
    public var listeners = 0
}

/// One stream per path, however many listen. Each listener used to open its
/// own: with the view, results, the Mac's answer and the open chat's turn
/// that was four held connections, and every command opened a fifth. The
/// Realtime Database speaks HTTP/1.1, where URLSession allows four
/// connections per host on iOS, so presence pings and commands queued behind
/// streams that never end: the "Sending…" that hung, and a Mac that thought
/// the phone had gone.
actor StreamHub {
    private let source: @Sendable (String) -> AsyncStream<StreamEvent>
    private struct Upstream {
        var task: Task<Void, Never>?
        var listeners: [UUID: AsyncStream<StreamEvent>.Continuation] = [:]
        var health: StreamHealth
    }
    private var upstreams: [String: Upstream] = [:]

    init(source: @escaping @Sendable (String) -> AsyncStream<StreamEvent>) {
        self.source = source
    }

    func subscribe(_ path: String) -> AsyncStream<StreamEvent> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<StreamEvent>.makeStream(bufferingPolicy: .bufferingNewest(64))
        continuation.onTermination = { [weak self] _ in
            Task { await self?.leave(path, id) }
        }
        if var upstream = upstreams[path] {
            upstream.listeners[id] = continuation
            upstream.health.listeners = upstream.listeners.count
            if upstream.health.connected { continuation.yield(.resync) }
            upstreams[path] = upstream
        } else {
            upstreams[path] = Upstream(listeners: [id: continuation], health: StreamHealth(path: path, listeners: 1))
            let events = source(path)
            upstreams[path]?.task = Task { [weak self] in
                for await event in events { await self?.forward(path, event) }
            }
        }
        return stream
    }

    func health() -> [StreamHealth] {
        upstreams.values.map(\.health).sorted { $0.path < $1.path }
    }

    private func forward(_ path: String, _ event: StreamEvent, now: Date = Date()) {
        guard var upstream = upstreams[path] else { return }
        switch event {
        case .connected:
            upstream.health.connected = true
            upstream.health.connectedAt = now
            upstream.health.lastEventAt = now
        case .dropped:
            upstream.health.connected = false
            upstream.health.drops += 1
        case .change(_, let data):
            upstream.health.lastEventAt = now
            upstream.health.bytes += data?.utf8.count ?? 0
        case .keepAlive:
            upstream.health.lastEventAt = now
        case .resync:
            break
        }
        upstreams[path] = upstream
        for listener in upstream.listeners.values { listener.yield(event) }
    }

    private func leave(_ path: String, _ id: UUID) {
        guard var upstream = upstreams[path] else { return }
        upstream.listeners[id] = nil
        upstream.health.listeners = upstream.listeners.count
        if upstream.listeners.isEmpty {
            upstream.task?.cancel()
            upstreams[path] = nil
        } else {
            upstreams[path] = upstream
        }
    }
}

/// Reads a response body line by line; injectable so the stream is testable.
public protocol LineStreamTransport: Sendable {
    func lines(for request: URLRequest) async throws -> AsyncThrowingStream<String, Error>
}

extension URLSession: LineStreamTransport {
    public func lines(for request: URLRequest) async throws -> AsyncThrowingStream<String, Error> {
        let (bytes, response) = try await bytes(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw RealtimeDatabaseClient.Failure.http(status) }
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await line in bytes.lines { continuation.yield(line) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// The same channel verbs as the Mac's src/remote/rtdb-rest.ts, plus a change
/// stream (Server-Sent Events), so the phone hears about a new view or a
/// command's result as it is written instead of on its next poll.
public struct RealtimeDatabaseClient: ChannelBackend {
    public enum Failure: Error, Equatable { case http(Int), streamCancelled }

    let base: String
    let query: String
    let transport: HTTPTransport
    let streams: LineStreamTransport
    let hub: StreamHub

    /// Keep-alives come every 30 s; this long without a byte means the connection is dead.
    static let stallSeconds: TimeInterval = 45
    /// Reconnects start at once and back off only this far: the app streams
    /// only while it is on screen, where a minute's wait reads as broken.
    static let retryMinSeconds: Double = 0.5
    static let retryMaxSeconds: Double = 5

    /// `databaseURL` is the instance root; a query on it (the emulator's `?ns=`) is kept on every request.
    public init(databaseURL: String, transport: HTTPTransport = URLSession.shared, streams: LineStreamTransport = URLSession.shared) {
        let parts = databaseURL.split(separator: "?", maxSplits: 1).map(String.init)
        var root = parts.first ?? ""
        while root.hasSuffix("/") { root.removeLast() }
        base = root
        query = parts.count > 1 ? parts[1] : ""
        self.transport = transport
        self.streams = streams
        let (base, query) = (base, query)
        hub = StreamHub { path in
            var request = URLRequest(url: Self.url(base: base, query: query, path: path))
            request.setValue("text/event-stream", forHTTPHeaderField: "accept")
            request.timeoutInterval = Self.stallSeconds
            return Self.rawEvents(request, streams: streams)
        }
    }

    public func get(_ path: String) async throws -> ChannelDocument? {
        let (data, response) = try await transport.data(for: request(path, method: "GET"))
        try check(response)
        guard let json = try JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed) as? [String: Any] else { return nil }
        return Self.decoded(json)
    }

    public func set(_ path: String, _ document: ChannelDocument) async throws {
        var request = request(path, method: "PUT", silent: true)
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: Self.encoded(document))
        let (_, response) = try await transport.data(for: request)
        try check(response)
    }

    public func delete(_ path: String) async throws {
        let (_, response) = try await transport.data(for: request(path, method: "DELETE", silent: true))
        try check(response)
    }

    /// Yields once per `put`/`patch`, including the one the server sends on
    /// connect, and once when joining a stream that is already open.
    public func changes(_ path: String) -> AsyncStream<Void>? {
        let hub = hub
        return AsyncStream { continuation in
            let task = Task {
                for await event in await hub.subscribe(path) {
                    switch event {
                    case .change, .resync: continuation.yield(())
                    default: break
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// The document at `path` as it changes. The server sends the whole value
    /// on connect and with every overwrite (`set` always writes the whole
    /// document), so a re-read is only needed for a partial change.
    public func documents(_ path: String) -> AsyncStream<DocumentChange>? {
        let hub = hub
        return AsyncStream { continuation in
            let task = Task {
                for await event in await hub.subscribe(path) {
                    switch event {
                    case .change(_, let data): continuation.yield(Self.change(from: data))
                    case .resync: continuation.yield(.refetch)
                    default: break
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Several documents of `collection` over one stream on the collection.
    public func events(in collection: String, documents names: [String]) -> AsyncStream<ChannelEvent>? {
        let hub = hub
        return AsyncStream { continuation in
            let task = Task {
                for await event in await hub.subscribe(collection) {
                    switch event {
                    case .connected: continuation.yield(.connected); continuation.yield(.heard)
                    case .dropped: continuation.yield(.dropped)
                    case .keepAlive: continuation.yield(.heard)
                    case .resync:
                        continuation.yield(.heard)
                        for name in names { continuation.yield(.document(name, .refetch)) }
                    case .change(let name, let data):
                        continuation.yield(.heard)
                        for (doc, change) in Self.childChanges(event: name, data: data, names: names) {
                            continuation.yield(.document(doc, change))
                        }
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func streamHealth() async -> [StreamHealth] { await hub.health() }

    /// What a `put`/`patch` event's data line says about the document at the watched path.
    static func change(from data: String?) -> DocumentChange {
        guard let data,
              let event = try? JSONSerialization.jsonObject(with: Data(data.utf8), options: .fragmentsAllowed) as? [String: Any],
              event["path"] as? String == "/"
        else { return .refetch }
        if event["data"] is NSNull { return .value(nil) }
        guard let body = event["data"] as? [String: Any], let document = decoded(body) else { return .refetch }
        return .value(document)
    }

    /// What an event on a collection's stream says about each of `names`
    /// (documents directly under it); documents it does not touch are left out.
    static func childChanges(event name: String, data: String?, names: [String]) -> [(String, DocumentChange)] {
        guard let data,
              let event = try? JSONSerialization.jsonObject(with: Data(data.utf8), options: .fragmentsAllowed) as? [String: Any],
              let path = event["path"] as? String
        else { return names.map { ($0, .refetch) } }
        let body = event["data"]
        func value(_ child: Any?) -> DocumentChange {
            guard let child, !(child is NSNull) else { return .value(nil) }
            guard let fields = child as? [String: Any], let document = decoded(fields) else { return .refetch }
            return .value(document)
        }
        let parts = path.split(separator: "/").map(String.init)
        guard let first = parts.first else {
            // The whole collection: a put replaces it (absent means deleted), a patch names only what changed.
            if body is NSNull { return names.map { ($0, .value(nil)) } }
            guard let children = body as? [String: Any] else { return names.map { ($0, .refetch) } }
            if name == "patch" { return names.compactMap { children.keys.contains($0) ? ($0, value(children[$0])) : nil } }
            return names.map { ($0, value(children[$0])) }
        }
        guard names.contains(first) else { return [] }
        return [(first, parts.count == 1 ? value(body) : .refetch)]
    }

    /// The events of one connection after another, until cancelled.
    static func rawEvents(_ request: URLRequest, streams: LineStreamTransport) -> AsyncStream<StreamEvent> {
        AsyncStream { continuation in
            let task = Task {
                var retry = retryMinSeconds
                while !Task.isCancelled {
                    do {
                        // Blank lines are dropped by the line reader, so an event is its `event:` line and the `data:` after it.
                        var pending: String?
                        var opened = false
                        for try await line in try await streams.lines(for: request) {
                            if !opened {
                                opened = true
                                retry = retryMinSeconds
                                continuation.yield(.connected)
                            }
                            if line.hasPrefix("event:") {
                                if let name = pending { continuation.yield(.change(name: name, data: nil)) }
                                let name = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
                                pending = (name == "put" || name == "patch") ? name : nil
                                if name == "keep-alive" { continuation.yield(.keepAlive) }
                                if name == "cancel" || name == "auth_revoked" { throw Failure.streamCancelled }
                            } else if line.hasPrefix("data:"), let name = pending {
                                pending = nil
                                continuation.yield(.change(name: name, data: String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)))
                            }
                        }
                        if let name = pending { continuation.yield(.change(name: name, data: nil)) }
                    } catch {}
                    if Task.isCancelled { break }
                    continuation.yield(.dropped)
                    try? await Task.sleep(for: .seconds(retry))
                    retry = min(retry * 2, retryMaxSeconds)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func url(_ path: String, silent: Bool = false) -> URL {
        Self.url(base: base, query: query, path: path, silent: silent)
    }

    static func url(base: String, query: String, path: String, silent: Bool = false) -> URL {
        let clean = path.split(separator: "/").map {
            $0.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_"))) ?? String($0)
        }.joined(separator: "/")
        let search = [query, silent ? "print=silent" : ""].filter { !$0.isEmpty }.joined(separator: "&")
        return URL(string: "\(base)/\(clean).json" + (search.isEmpty ? "" : "?\(search)"))!
    }

    private func request(_ path: String, method: String, silent: Bool = false) -> URLRequest {
        var request = URLRequest(url: url(path, silent: silent))
        request.httpMethod = method
        request.timeoutInterval = 15
        return request
    }

    private func check(_ response: URLResponse) throws {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw Failure.http(status) }
    }

    static func encoded(_ document: ChannelDocument) -> [String: Any] {
        var body: [String: Any] = ["box": document.box]
        if let sig = document.sig { body["sig"] = sig }
        if let device = document.device { body["device"] = device }
        if let at = document.at { body["at"] = at }
        return body
    }

    static func decoded(_ json: [String: Any]) -> ChannelDocument? {
        guard let box = json["box"] as? String else { return nil }
        return ChannelDocument(
            box: box,
            sig: json["sig"] as? String,
            device: json["device"] as? String,
            at: (json["at"] as? NSNumber)?.int64Value
        )
    }
}
