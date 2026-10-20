import Foundation

/// Talks to the running Squeak daemon. Transport and token are injected so
/// tests never touch the network or the real token file.
public struct DaemonClient: Sendable {
    public static let defaultPort = 8477

    public let baseURL: URL
    private let transport: any HTTPTransport
    let tokenProvider: @Sendable () -> String?

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
    public func reply(replyTarget: String, text: String, mode: SendMode = .queue) async -> SendResult {
        guard let token = tokenProvider() else { return .notSent(reason: "Squeak's access token was not found") }
        // A queued message carries no mode at all: the body is exactly what older daemons expect.
        var fields = ["text": text]
        if mode == .steer { fields["mode"] = mode.rawValue }
        guard let body = try? JSONEncoder().encode(fields) else { return .notSent(reason: "Could not encode the message") }
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
            return .accepted(via: parsed?.via ?? "conductor", delivery: parsed?.delivery.flatMap(Delivery.init(rawValue:)), note: parsed?.note)
        case "refused":
            return .refused(reason: parsed?.reason ?? "Squeak refused the message")
        default:
            if (400..<500).contains(response.status) { return .refused(reason: "Squeak rejected the request (HTTP \(response.status))") }
            return .uncertain(reason: "Unexpected reply from Squeak (HTTP \(response.status)). Check Conductor before sending again.")
        }
    }

    // MARK: Usage

    /// Takes one fresh Claude limits reading. This runs a real, tiny Claude call on the daemon, so it
    /// is only ever called from the user's own press of Refresh. Nil when the daemon predates the route.
    public func refreshClaudeUsage() async throws -> ClaudeRefreshResult? {
        let r = try await post("/control/usage/claude-refresh", timeout: 100)
        if r.status == 404 || r.status == 503 { return nil }
        try Self.check(r.status)
        let body = try decode(DaemonClaudeRefreshBody.self, r.body)
        return ClaudeRefreshResult(
            claude: body.claudeLimits?.usage, throttled: body.throttled ?? false, refreshed: body.refreshed ?? false, error: body.error)
    }

    // MARK: Channels (nil means the daemon predates the route: 404)

    public func channels() async throws -> ChannelsStatus? {
        let r = try await get("/control/channels", token: true)
        if r.status == 404 { return nil }
        try Self.check(r.status)
        return try decode(ChannelsStatus.self, r.body)
    }

    public func telegramCandidates() async throws -> [TelegramCandidate]? {
        let r = try await get("/control/telegram/candidates", token: true)
        if r.status == 404 { return nil }
        try Self.check(r.status)
        return try decode(TelegramCandidatesBody.self, r.body).chats
    }

    /// Sends one real message to the linked chats. Only ever call this from the user's own tap.
    public func telegramTest() async throws -> TelegramTestResult? {
        let r = try await post("/control/telegram/test", timeout: 20)
        if r.status == 404 { return nil }
        // The daemon may answer a refusal with a body and a 4xx; read it when it is ours.
        if let result = try? JSONDecoder().decode(TelegramTestResult.self, from: r.body), r.status != 401, r.status != 403 { return result }
        try Self.check(r.status)
        return try decode(TelegramTestResult.self, r.body)
    }

    // MARK: iPhone pairing (RemoteBridge through /control/remote/*)

    /// nil when the daemon has no such route (404) or no phone channel behind it (503).
    public func remoteStatus() async throws -> RemoteStatus? {
        let r = try await get("/control/remote/status", token: true)
        if r.status == 404 || r.status == 503 { return nil }
        try Self.check(r.status)
        return try decode(RemoteStatus.self, r.body)
    }

    /// Opens the pairing window; the URL is the QR payload and a secret.
    public func remotePair() async throws -> RemotePairing? {
        let r = try await post("/control/remote/pair")
        if r.status == 404 || r.status == 503 { return nil }
        try Self.check(r.status)
        guard let p = try? JSONDecoder().decode(RemotePairing.self, from: r.body), !p.url.isEmpty else { return nil }
        return p
    }

    public func remoteApprove(deviceId: String) async throws -> Bool { try await remoteAction("approve", deviceId) }
    public func remoteReject(deviceId: String) async throws -> Bool { try await remoteAction("reject", deviceId) }
    public func remoteRevoke(deviceId: String) async throws -> Bool { try await remoteAction("revoke", deviceId) }
    public func remoteReset() async throws -> Bool { try await remoteAction("reset", nil) }

    private func remoteAction(_ action: String, _ deviceId: String?) async throws -> Bool {
        let path = "/control/remote/\(action)" + (deviceId.map { "/" + Self.encode($0) } ?? "")
        let r = try await post(path)
        try Self.check(r.status)
        struct Ok: Decodable { var ok: Bool? }
        return (try? JSONDecoder().decode(Ok.self, from: r.body))?.ok ?? false
    }

    // MARK: Plumbing

    // Reached by the New chat extension (NewChat.swift) in this module.
    var transportForControl: any HTTPTransport { transport }
    func controlURL(_ pathAndQuery: String) -> URL { url(pathAndQuery) }
    func getControl(_ path: String) async throws -> HTTPResponse { try await get(path, token: true) }

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

    /// Starts (`minutes` nil: until ended), extends or ends the Mac's awake session
    /// (`POST /control/keep-awake`). Nil when it worked, else the daemon's reason.
    public func changeAwake(action: String, minutes: Int? = nil, lid: Bool = false) async -> String? {
        var body: [String: Any] = ["action": action]
        if let minutes { body["minutes"] = minutes }
        if lid { body["lid"] = true }
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return "Couldn't send that." }
        do {
            let r = try await post("/control/keep-awake", body: data)
            if (200..<300).contains(r.status) { return nil }
            if r.status == 401 || r.status == 403 { return "Squeak rejected the access token" }
            let reason = (try? JSONSerialization.jsonObject(with: r.body)) as? [String: Any]
            return (reason?["error"] as? String) ?? "Squeak couldn't change that."
        } catch {
            return "Squeak isn't running."
        }
    }

    /// The sudoers text lid-closed sessions need, built by the daemon for its own user
    /// (`GET /control/keep-awake/lid-rule`). Nil from a daemon without it.
    public func lidRule() async -> String? {
        guard let r = try? await get("/control/keep-awake/lid-rule", token: true), (200..<300).contains(r.status),
              let json = (try? JSONSerialization.jsonObject(with: r.body)) as? [String: Any],
              json["path"] as? String == LidRule.path else { return nil }
        return json["rule"] as? String
    }

    /// Asks the daemon to look for the rule again, right after it was installed.
    public func recheckLidRule() async {
        _ = try? await post("/control/keep-awake", body: Data(#"{"action":"recheck-lid"}"#.utf8))
    }

    private func post(_ path: String, body: Data = Data("{}".utf8), timeout: TimeInterval = 8) async throws -> HTTPResponse {
        guard let t = tokenProvider() else { throw AdapterError.tokenMissing }
        do {
            return try await transport.send(HTTPRequest(
                method: "POST", url: url(path), headers: ["x-squeak-token": t, "content-type": "application/json"],
                body: body, timeout: timeout))
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
