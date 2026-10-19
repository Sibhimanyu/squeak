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

    /// `databaseURL` is the instance root; a query on it (the emulator's `?ns=`) is kept on every request.
    public init(databaseURL: String, transport: HTTPTransport = URLSession.shared, streams: LineStreamTransport = URLSession.shared) {
        let parts = databaseURL.split(separator: "?", maxSplits: 1).map(String.init)
        var root = parts.first ?? ""
        while root.hasSuffix("/") { root.removeLast() }
        base = root
        query = parts.count > 1 ? parts[1] : ""
        self.transport = transport
        self.streams = streams
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

    /// Reconnects with backoff until the consumer stops iterating. Yields once
    /// per `put`/`patch`, including the one the server sends on connect.
    public func changes(_ path: String) -> AsyncStream<Void>? {
        let events = events(path)
        return AsyncStream { continuation in
            let task = Task {
                for await _ in events { continuation.yield(()) }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// The document at `path` as it changes. The server sends the whole value
    /// on connect and with every overwrite (`set` always writes the whole
    /// document), so a re-read is only needed for a partial change.
    public func documents(_ path: String) -> AsyncStream<DocumentChange>? {
        let events = events(path)
        return AsyncStream { continuation in
            let task = Task {
                for await data in events { continuation.yield(Self.change(from: data)) }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

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

    /// The data line of every `put`/`patch` (nil when a `put`/`patch` came without one).
    private func events(_ path: String) -> AsyncStream<String?> {
        var request = request(path, method: "GET")
        request.setValue("text/event-stream", forHTTPHeaderField: "accept")
        request.timeoutInterval = 75 // keep-alives come every 30s
        let streams = streams
        return AsyncStream { continuation in
            let task = Task {
                var retry: Double = 1
                while !Task.isCancelled {
                    do {
                        // Blank lines are dropped by the line reader, so an event is its `event:` line and the `data:` after it.
                        var pending: String?
                        for try await line in try await streams.lines(for: request) {
                            retry = 1
                            if line.hasPrefix("event:") {
                                if pending != nil { continuation.yield(nil) }
                                let name = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
                                pending = (name == "put" || name == "patch") ? name : nil
                                if name == "cancel" || name == "auth_revoked" { throw Failure.streamCancelled }
                            } else if line.hasPrefix("data:"), pending != nil {
                                pending = nil
                                continuation.yield(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
                            }
                        }
                        if pending != nil { continuation.yield(nil) }
                    } catch {}
                    if Task.isCancelled { break }
                    try? await Task.sleep(for: .seconds(retry))
                    retry = min(retry * 2, 60)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func url(_ path: String, silent: Bool = false) -> URL {
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
