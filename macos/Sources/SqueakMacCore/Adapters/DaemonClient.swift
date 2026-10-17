import Foundation

/// Talks to the running Squeak daemon. Transport and token are injected so
/// tests never touch the network or the real token file.
public struct DaemonClient: Sendable {
    public static let defaultPort = 8477

    public let baseURL: URL
    private let transport: any HTTPTransport
    private let tokenProvider: @Sendable () -> String?

    public init(baseURL: URL, transport: any HTTPTransport = URLSessionTransport(), tokenProvider: @escaping @Sendable () -> String?) {
        self.baseURL = baseURL
        self.transport = transport
        self.tokenProvider = tokenProvider
    }

    /// Port from `SQUEAK_DAEMON_PORT`, else 8477; token from the daemon's token file.
    public static func live(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        tokenFile: URL = DaemonClient.defaultTokenFile,
        transport: any HTTPTransport = URLSessionTransport()
    ) -> DaemonClient {
        let port = environment["SQUEAK_DAEMON_PORT"].flatMap { Int($0) } ?? defaultPort
        return DaemonClient(
            baseURL: URL(string: "http://127.0.0.1:\(port)")!,
            transport: transport,
            tokenProvider: { Self.readToken(at: tokenFile) }
        )
    }

    public static var defaultTokenFile: URL {
        URL.homeDirectory.appending(path: "Library/Application Support/squeak/hook-token")
    }

    public static func readToken(at url: URL) -> String? {
        guard let s = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    public var hasToken: Bool { tokenProvider() != nil }

    // MARK: Routes

    public func state() async throws -> DaemonState {
        let r = try await get("/state", token: false)
        guard r.status == 200 else { throw AdapterError.http(r.status) }
        return try decode(DaemonState.self, r.body)
    }

    /// nil when the daemon predates the transcript route (404).
    public func transcript(replyTarget: String, limit: Int) async throws -> DaemonTranscript? {
        let r = try await get("/control/session/\(Self.encode(replyTarget))/transcript?limit=\(limit)", token: true)
        if r.status == 404 { return nil }
        try Self.check(r.status)
        return try decode(DaemonTranscript.self, r.body)
    }

    public func lastMessage(replyTarget: String) async throws -> DaemonLastMessage? {
        let r = try await get("/control/session/\(Self.encode(replyTarget))/message", token: true)
        if r.status == 404 { return nil }
        try Self.check(r.status)
        return try decode(DaemonLastMessage.self, r.body)
    }

    public func activity(sessionKey: String) async throws -> DaemonActivity {
        let r = try await get("/control/session/\(Self.encode(sessionKey))/activity", token: true)
        try Self.check(r.status)
        return try decode(DaemonActivity.self, r.body)
    }

    /// Maps every outcome to a `SendResult`; this never throws and never retries.
    public func reply(replyTarget: String, text: String) async -> SendResult {
        guard let token = tokenProvider() else { return .notSent(reason: "Squeak's access token was not found") }
        guard let body = try? JSONEncoder().encode(["text": text]) else { return .notSent(reason: "Could not encode the message") }
        let request = HTTPRequest(
            method: "POST",
            url: url("/control/session/\(Self.encode(replyTarget))/reply"),
            headers: ["x-squeak-token": token, "content-type": "application/json"],
            body: body,
            timeout: 20
        )
        let response: HTTPResponse
        do {
            response = try await transport.send(request)
        } catch let e as TransportError {
            switch e {
            case .connectionRefused: return .notSent(reason: "Squeak is not running")
            case .timedOut: return .uncertain(reason: "Timed out waiting for Squeak. Check Conductor before sending again.")
            case .connectionLost: return .uncertain(reason: "Connection to Squeak dropped. Check Conductor before sending again.")
            case .other(let m): return .notSent(reason: m)
            }
        } catch {
            return .notSent(reason: "Request failed")
        }
        if response.status == 401 || response.status == 403 { return .notSent(reason: "Squeak rejected the access token") }
        let parsed = try? JSONDecoder().decode(DaemonReplyBody.self, from: response.body)
        switch parsed?.status {
        case "started":
            return .accepted(via: parsed?.via ?? "conductor")
        case "refused":
            return .refused(reason: parsed?.reason ?? "Squeak refused the message")
        default:
            if (400..<500).contains(response.status) { return .refused(reason: "Squeak rejected the request (HTTP \(response.status))") }
            return .uncertain(reason: "Unexpected reply from Squeak (HTTP \(response.status)). Check Conductor before sending again.")
        }
    }

    // MARK: Plumbing

    private static let pathAllowed: CharacterSet = {
        var s = CharacterSet.alphanumerics
        s.insert(charactersIn: "-._~:")
        return s
    }()

    static func encode(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: pathAllowed) ?? s
    }

    private func url(_ pathAndQuery: String) -> URL {
        URL(string: baseURL.absoluteString + pathAndQuery) ?? baseURL
    }

    private func get(_ path: String, token: Bool) async throws -> HTTPResponse {
        var headers: [String: String] = [:]
        if token {
            guard let t = tokenProvider() else { throw AdapterError.tokenMissing }
            headers["x-squeak-token"] = t
        }
        do {
            return try await transport.send(HTTPRequest(url: url(path), headers: headers, timeout: 5))
        } catch let e as TransportError {
            switch e {
            case .connectionRefused: throw AdapterError.daemonDown
            case .timedOut: throw AdapterError.timedOut
            case .connectionLost, .other: throw AdapterError.daemonDown
            }
        }
    }

    private static func check(_ status: Int) throws {
        if status == 401 || status == 403 { throw AdapterError.tokenRejected }
        guard (200..<300).contains(status) else { throw AdapterError.http(status) }
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try JSONDecoder().decode(type, from: data) } catch { throw AdapterError.badResponse("unreadable \(T.self)") }
    }
}
