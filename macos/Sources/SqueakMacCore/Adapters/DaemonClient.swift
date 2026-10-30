import Foundation

/// Talks to the running Squeak daemon. Transport and token are injected so
/// tests never touch the network or the real token file.
public struct DaemonClient: Sendable {
    public static let defaultPort = 8477

    public let baseURL: URL
    private let transport: any HTTPTransport
    let tokenProvider: @Sendable () -> String?
    /// Told when a reply's result shows Squeak Hands lacked a grant (the menu-bar tips listen); never changes the result.
    public var onReplySignal: (@Sendable (ReplyGrantSignal) -> Void)?

    public init(baseURL: URL, transport: any HTTPTransport = URLSessionTransport(), tokenProvider: @escaping @Sendable () -> String?,
                onReplySignal: (@Sendable (ReplyGrantSignal) -> Void)? = nil) {
        self.baseURL = baseURL
        self.transport = transport
        self.tokenProvider = tokenProvider
        self.onReplySignal = onReplySignal
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
    public func transcript(replyTarget: String, limit: Int, before: String? = nil) async throws -> DaemonTranscript? {
        // `before` is digits and nothing else; anything else is not sent.
        var query = "limit=\(limit)"
        if let before, !before.isEmpty, before.allSatisfy(\.isASCII), before.allSatisfy(\.isNumber) { query += "&before=\(before)" }
        let r = try await get("/control/session/\(Self.encode(replyTarget))/transcript?\(query)", token: true)
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

    /// One subagent's steps. nil when the daemon does not know the task or predates the route (404); a task id that
    /// is not a plain id is never sent.
    public func subagentActivity(sessionKey: String, taskId: String) async throws -> DaemonSubagentFeed? {
        guard SubagentFeedPresentation.isValidTaskId(taskId) else { return nil }
        let r = try await get("/control/session/\(Self.encode(sessionKey))/subagent/\(Self.encode(taskId))/activity", token: true)
        if r.status == 404 { return nil }
        try Self.check(r.status)
        return try decode(DaemonSubagentFeed.self, r.body)
    }

    // MARK: Queue (Conductor chats; nil / a clear result means the daemon predates the routes)

    /// The messages waiting for the turn to end, oldest first. nil when they cannot be read: an older daemon
    /// (404/503), a chat that is not Conductor's, or Conductor's relay being down.
    public func queue(sessionId: String) async throws -> [QueuedMessage]? {
        let r = try await get("/control/session/\(Self.encode(sessionId))/queue", token: true)
        if r.status == 404 || r.status == 503 { return nil }
        try Self.check(r.status)
        return try decode(DaemonQueueBody.self, r.body).items.sorted { $0.position < $1.position }
    }

    /// Steers a queued message into the running turn now. One attempt, never retried.
    public func promoteQueued(sessionId: String, messageId: String) async -> QueueChangeResult {
        await changeQueued(sessionId: sessionId, messageId: messageId, verb: "promote")
    }

    /// Deletes a queued message. One attempt, never retried.
    public func cancelQueued(sessionId: String, messageId: String) async -> QueueChangeResult {
        await changeQueued(sessionId: sessionId, messageId: messageId, verb: "cancel")
    }

    private func changeQueued(sessionId: String, messageId: String, verb: String) async -> QueueChangeResult {
        // A message id is a plain token; anything else is never sent.
        guard !messageId.isEmpty, messageId.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }) else {
            return .failed(reason: "That queued message can't be changed.")
        }
        do {
            let r = try await post("/control/session/\(Self.encode(sessionId))/queue/\(messageId)/\(verb)", timeout: 20)
            if r.status == 401 || r.status == 403 { return .failed(reason: "Squeak rejected the access token") }
            let reply = (try? JSONSerialization.jsonObject(with: r.body)) as? [String: Any]
            if reply?["ok"] as? Bool == true { return .done }
            if r.status == 404, reply != nil { return .alreadySent }
            if r.status == 404 || r.status == 503 { return .failed(reason: "Update the Squeak service on this Mac to do that from here.") }
            return .failed(reason: (reply?["reason"] as? String) ?? "Squeak couldn't change that message.")
        } catch AdapterError.tokenMissing {
            return .failed(reason: "Squeak's access token was not found")
        } catch {
            return .failed(reason: "Squeak isn't running.")
        }
    }

    /// Maps every outcome to a `SendResult`; this never throws and never retries.
    /// `answersTurn` names the turn this answers; the daemon refuses it once the chat has moved on.
    public func reply(replyTarget: String, text: String, mode: SendMode = .queue, answersTurn: String? = nil) async -> SendResult {
        guard let token = tokenProvider() else { return .notSent(reason: "Squeak's access token was not found") }
        // A queued message carries no mode at all: the body is exactly what older daemons expect.
        var fields = ["text": text]
        if mode == .steer { fields["mode"] = mode.rawValue }
        if let answersTurn, !answersTurn.isEmpty { fields["answersTurn"] = answersTurn }
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
        if let signal = ReplyGrantSignal.read(
            via: parsed?.via, fallbackReason: parsed?.fallbackReason, refusedReason: parsed?.status == "refused" ? parsed?.reason : nil) {
            onReplySignal?(signal)
        }
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

    /// Takes one fresh Claude limits reading. The daemon fetches usage from Claude without consuming tokens, so it
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

    // MARK: Notification settings (nil means the daemon predates the route: 404)

    public func notifySettings() async throws -> NotifySettings? {
        let r = try await get("/control/notify", token: true)
        if r.status == 404 { return nil }
        try Self.check(r.status)
        return try decode(NotifySettings.self, r.body)
    }

    /// One change, one key. `.saved` carries the settings after it when the answer is readable.
    public func changeNotify(_ channel: NotifyChannel, _ change: NotifyChange) async throws -> NotifyOutcome {
        let r = try await post("/control/notify", body: change.requestBody(channel: channel))
        if r.status == 404 { return .outdated }
        try Self.check(r.status)
        return .saved(try? JSONDecoder().decode(NotifySettings.self, from: r.body))
    }

    // MARK: Voice (nil means the daemon predates the route: 404)

    public func voiceSettings() async throws -> VoiceSettings? {
        let r = try await get("/control/voice", token: true)
        if r.status == 404 { return nil }
        try Self.check(r.status)
        return try decode(VoiceSettings.self, r.body)
    }

    /// Sets the extension to ring, or clears it with nil. The daemon refuses anything but 2 to 6 digits.
    public func setVoiceCallee(_ callee: String?) async throws -> VoiceSettings? {
        let r = try await post("/control/voice", body: VoiceSettings.requestBody(callee: callee))
        if r.status == 404 { return nil }
        try Self.check(r.status)
        return try? JSONDecoder().decode(VoiceSettings.self, from: r.body)
    }

    /// Turns the Mac's realistic call voice on or off, or picks its voice. nil = a daemon without the route (404).
    public func setNaturalVoice(enabled: Bool? = nil, voice: String? = nil) async throws -> VoiceSettings? {
        let r = try await post("/control/voice", body: NaturalVoice.requestBody(enabled: enabled, voice: voice))
        if r.status == 404 { return nil }
        try Self.check(r.status)
        return try? JSONDecoder().decode(VoiceSettings.self, from: r.body)
    }

    /// A fixed WAV sample made locally using the call voice. Never places a call or changes its settings.
    public func previewNaturalVoice(_ voice: String) async throws -> Data {
        let body = try JSONSerialization.data(withJSONObject: ["voice": voice])
        let r = try await post("/control/voice/preview", body: body, timeout: 65)
        try Self.check(r.status)
        return r.body
    }

    /// Places a test call. `.done` carries the view with `lastTest` ringing; `.refused` the daemon's sentence.
    public func testVoiceCall() async throws -> PinOutcome {
        let r = try await post("/control/voice", body: VoiceSettings.testRequestBody())
        if r.status == 404 { return .outdated }
        if r.status == 400 { return .refused(PinOutcome.reason(from: r.body)) }
        try Self.check(r.status)
        return .done(try? JSONDecoder().decode(VoiceSettings.self, from: r.body))
    }

    /// Pauses or resumes calls. nil = a daemon without the route (404).
    public func setVoicePause(_ choice: VoicePauseChoice) async throws -> VoiceSettings? {
        let r = try await post("/control/voice", body: choice.requestBody())
        if r.status == 404 { return nil }
        try Self.check(r.status)
        return try? JSONDecoder().decode(VoiceSettings.self, from: r.body)
    }

    /// Replaces the quick-workspace list. nil = a daemon without the route (404).
    public func setVoiceFavorites(_ list: [FavoriteWorkspace]) async throws -> VoiceSettings? {
        let r = try await post("/control/voice", body: QuickWorkspaces.requestBody(list))
        if r.status == 404 { return nil }
        try Self.check(r.status)
        return try? JSONDecoder().decode(VoiceSettings.self, from: r.body)
    }

    /// Types the add-on's code. `.unavailable` = a daemon without the claim route (404).
    public func claimGateway(code: String) async throws -> GatewayClaimOutcome {
        let r = try await post("/control/voice/gateway/claim", body: GatewayClaim.requestBody(code: code), timeout: 20)
        return GatewayClaim.outcome(status: r.status, body: r.body)
    }

    /// One PIN action (change, turn off, turn on, reset). The PIN is only in the request body, never logged or kept.
    /// `.outdated` = a daemon without the route (404).
    public func pinAction(_ action: PinAction) async throws -> PinOutcome {
        let r = try await post("/control/voice", body: action.requestBody(), timeout: 30)
        if r.status == 404 { return .outdated }
        if r.status == 400 { return .refused(PinOutcome.reason(from: r.body)) }
        try Self.check(r.status)
        return .done(try? JSONDecoder().decode(VoiceSettings.self, from: r.body))
    }

    // MARK: Phone-call gateway (nil means the daemon predates the routes: 404 or 503)

    public func gatewayView() async throws -> GatewayView? {
        let r = try await get("/control/voice/gateway", token: true)
        if r.status == 404 || r.status == 503 { return nil }
        try Self.check(r.status)
        return try decode(GatewayView.self, r.body)
    }

    public func startGatewayPairing() async throws -> GatewayPairResponse? {
        let r = try await post("/control/voice/gateway/pair", timeout: 15)
        if r.status == 404 || r.status == 503 { return nil }
        try Self.check(r.status)
        return try decode(GatewayPairResponse.self, r.body)
    }

    /// Returns false when the daemon has no such route.
    public func approveGateway(_ approve: Bool) async throws -> Bool {
        let r = try await post("/control/voice/gateway/approve", body: GatewayText.approveBody(approve), timeout: 15)
        if r.status == 404 || r.status == 503 { return false }
        try Self.check(r.status)
        return true
    }

    /// Asks the add-on to update itself through Home Assistant. `.unavailable` = a daemon without the route.
    public func updateGatewayAddon() async throws -> GatewayUpdateOutcome {
        let r = try await post("/control/voice/gateway/update", body: GatewayUpdate.requestBody, timeout: 40)
        return GatewayUpdate.outcome(status: r.status, body: r.body)
    }

    /// Asks the daemon to look for a newer add-on now.
    public func checkGatewayUpdate() async throws -> GatewayCheckOutcome {
        let r = try await post("/control/voice/gateway/check", body: GatewayCheck.requestBody, timeout: 30)
        return GatewayCheck.outcome(status: r.status, body: r.body)
    }

    /// Call history and the gateway's log; nil when the daemon predates the route or phone calls are not set up.
    public func voiceCalls() async throws -> CallsView? {
        let r = try await get("/control/voice/calls", token: true)
        if r.status == 404 || r.status == 503 { return nil }
        try Self.check(r.status)
        return try decode(CallsView.self, r.body)
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

    /// Sets the Telegram bot's profile picture to Squeak's logo. Only ever call this from the user's own tap.
    public func setTelegramAvatar() async -> BotAvatarOutcome {
        do {
            let r = try await post("/control/telegram/avatar", timeout: 30)
            return BotAvatarOutcome.from(status: r.status, body: r.body)
        } catch {
            return BotAvatarOutcome.from(error: error)
        }
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

    /// Changes what a closed lid does during a lid-closed session (`action: "lid-actions"`); only the
    /// keys given change. Nil when it worked, else a reason.
    /// Changes switches of one mode: lid closed (the default), or with `open` what a session does with the lid open.
    public func setLidActions(_ settings: [String: Bool], open: Bool = false) async -> String? {
        var body: [String: Any] = ["action": "lid-actions", "settings": settings]
        if open { body["mode"] = "open" }
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

    /// Sets up hotspot failover (`POST /control/hotspot`): the iPhone hotspot's name and password (the daemon
    /// keeps the password in the login Keychain, and an empty `password` leaves the stored one alone), or
    /// clears it. Nil when it worked, else the daemon's reason. The password is never logged or kept here.
    public func setHotspot(ssid: String, password: String?, enabled: Bool = true) async -> String? {
        var body: [String: Any] = ["action": "configure", "ssid": ssid, "enabled": enabled]
        if let password, !password.isEmpty { body["password"] = password }
        return await hotspotCall(body)
    }

    public func clearHotspot() async -> String? { await hotspotCall(["action": "clear"]) }

    private func hotspotCall(_ body: [String: Any]) async -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return "Couldn't send that." }
        do {
            let r = try await post("/control/hotspot", body: data)
            if (200..<300).contains(r.status) { return nil }
            if r.status == 401 || r.status == 403 { return "Squeak rejected the access token" }
            if r.status == 404 || r.status == 503 { return "This version of the Squeak service can't set up a hotspot. Update it first." }
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

    /// The energy mode's sudoers text (`GET /control/power/rule`): exactly three `pmset -a powermode` commands.
    /// Nil from a daemon without it, or one naming any other path than `PowerRule`'s.
    public func powerRule() async -> String? {
        guard let r = try? await get("/control/power/rule", token: true), (200..<300).contains(r.status),
              let json = (try? JSONSerialization.jsonObject(with: r.body)) as? [String: Any],
              json["path"] as? String == PowerRule.path else { return nil }
        return json["rule"] as? String
    }

    /// Applies an Automatic, Low Power or High Power choice through the daemon's existing PowerMode guard.
    public func setPowerMode(_ choice: String) async -> String? {
        guard ["auto", "low", "high"].contains(choice) else { return "That energy mode isn't available." }
        guard let data = try? JSONSerialization.data(withJSONObject: ["choice": choice]) else { return "Couldn't send that." }
        do {
            let r = try await post("/control/power", body: data)
            if (200..<300).contains(r.status) { return nil }
            if r.status == 401 || r.status == 403 { return "Squeak rejected the access token" }
            let reason = (try? JSONSerialization.jsonObject(with: r.body)) as? [String: Any]
            return (reason?["error"] as? String) ?? "Squeak couldn't change the energy mode."
        } catch AdapterError.tokenMissing { return "Squeak's access token was not found" }
        catch { return "Squeak isn't running." }
    }

    /// Asks the daemon to look for the energy mode rule again, right after it was installed.
    public func recheckPower() async {
        _ = try? await post("/control/keep-awake", body: Data(#"{"action":"recheck-power"}"#.utf8))
    }

    /// Fan control's sudoers rule (`GET /control/heat/fan-rule`); nil from a daemon without it, or one
    /// naming any other path than `FanRule`'s.
    public func fanRule() async -> String? {
        guard let r = try? await get("/control/heat/fan-rule", token: true), (200..<300).contains(r.status),
              let json = (try? JSONSerialization.jsonObject(with: r.body)) as? [String: Any],
              json["path"] as? String == FanRule.path, json["helperPath"] as? String == FanRule.helperPath else { return nil }
        return json["rule"] as? String
    }

    // MARK: Chat and workspace actions

    /// The models a chat can run, as Conductor's picker lists them; empty from an older daemon.
    public func chatModels() async -> [DaemonChatModel] {
        guard let r = try? await get("/control/models", token: true), r.status == 200,
              let body = try? JSONDecoder().decode(DaemonChatModels.self, from: r.body) else { return [] }
        return body.models
    }

    /// Repositories a new workspace can be made in; nil from a daemon that cannot make one.
    public func workspaceRepos() async -> [DaemonRepo]? {
        struct Body: Decodable { var repos: [DaemonRepo]? }
        guard let r = try? await get("/control/workspace-repos", token: true), r.status == 200 else { return nil }
        return (try? JSONDecoder().decode(Body.self, from: r.body))?.repos
    }

    /// Conductor's Stop (`stop`), a new model (`setup`: model, thinking?, fast?) or a PR request (`pr`) for a
    /// Conductor chat. Nil when it worked, else why not, in words.
    public func chatAction(sessionId: String, action: String, body: [String: any Sendable] = [:]) async -> String? {
        await outcome("/control/session/\(Self.encode(sessionId))/\(action)", body: body).problem
    }

    /// Archive a workspace (`["action": "archive", "workspaceId": …]`) or make one (`["action": "create",
    /// "repoId": …]`). The new workspace's id, or why not.
    public func workspaceAction(_ body: [String: String]) async -> (workspaceId: String?, problem: String?) {
        await outcome("/control/workspace-action", body: body, timeout: 45)
    }

    private func outcome(_ path: String, body: [String: any Sendable], timeout: TimeInterval = 20) async -> (workspaceId: String?, problem: String?) {
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return (nil, "Couldn't send that.") }
        do {
            let r = try await post(path, body: data, timeout: timeout)
            if r.status == 401 || r.status == 403 { return (nil, "Squeak rejected the access token") }
            if r.status == 404 || r.status == 503 { return (nil, "Update Squeak on this Mac to do that from here.") }
            let reply = (try? JSONSerialization.jsonObject(with: r.body)) as? [String: Any]
            if reply?["ok"] as? Bool == true { return (reply?["workspaceId"] as? String, nil) }
            return (nil, (reply?["reason"] as? String) ?? "Squeak couldn't do that.")
        } catch {
            return (nil, "Squeak isn't running.")
        }
    }

    /// Asks the daemon to look for fan control again, right after it was installed.
    public func recheckFans() async {
        _ = try? await post("/control/keep-awake", body: Data(#"{"action":"recheck-fans"}"#.utf8))
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
