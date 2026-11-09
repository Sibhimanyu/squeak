import Foundation

/// Where the pinned (or trust-on-first-connect) Mac static key lives.
public protocol RelayHostKeyStore: Sendable {
    func load() -> Data?
    func save(_ key: Data)
}

/// In-memory store, for tests and for callers that persist elsewhere.
public final class InMemoryRelayHostKeyStore: RelayHostKeyStore, @unchecked Sendable {
    private let lock = NSLock()
    private var key: Data?
    public init(_ key: Data? = nil) { self.key = key }
    public func load() -> Data? { lock.withLock { key } }
    public func save(_ key: Data) { lock.withLock { self.key = key } }
}

/// File-backed store writing `<directory>/conductor-relay.json` (mode 0600) with
/// `{"hostStaticPublicKey": "<base64url>"}`. It is the same file the TypeScript
/// daemon and CLI use, and other keys in it (e.g. `credentials`) are preserved.
public struct FileRelayHostKeyStore: RelayHostKeyStore {
    public let fileURL: URL

    public init(directory: URL, fileName: String = "conductor-relay.json") {
        self.fileURL = directory.appendingPathComponent(fileName)
    }

    private func readDict() -> [String: Any] {
        guard let data = try? Data(contentsOf: fileURL),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        return obj
    }

    public func load() -> Data? {
        (readDict()["hostStaticPublicKey"] as? String).flatMap(RelayCrypto.b64urlDecode)
    }

    public func save(_ key: Data) {
        var dict = readDict()
        dict["hostStaticPublicKey"] = RelayCrypto.b64urlEncode(key)
        guard let data = try? JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted, .sortedKeys]) else { return }
        try? FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: fileURL, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
    }
}

public enum RelaySendResult: Equatable, Sendable {
    case ok
    case failed(reason: String)
}

/// The daemon-owned desktop relay (`service.ts`). Inert unless the override URL
/// is `http://127.0.0.1:<port>` and credentials are present: it never binds a
/// port, `isReady` stays false and `send` answers "relay not connected".
/// `start()` never throws; a held port is retried every `listenRetryInterval`.
public final class RelayService: @unchecked Sendable {
    public struct Config: Sendable {
        /// Conductor's `roundhouse_client_url_override` value, or nil when unset.
        public var overrideURL: String?
        public var credentials: DeviceCredentials?
        /// Real cloud backend for non-relay traffic; nil = offline mode (tests only).
        public var upstreamBaseURL: String?
        public var listenRetryInterval: TimeInterval

        public init(
            overrideURL: String?, credentials: DeviceCredentials?,
            upstreamBaseURL: String? = "https://api.conductor.build", listenRetryInterval: TimeInterval = 5
        ) {
            self.overrideURL = overrideURL
            self.credentials = credentials
            self.upstreamBaseURL = upstreamBaseURL
            self.listenRetryInterval = listenRetryInterval
        }
    }

    private let config: Config
    private let keyStore: RelayHostKeyStore
    private let lock = NSLock()
    private var server: RelayServer?
    private var client: PhoneClient?
    private var stopped = false
    private var startTask: Task<Void, Never>?
    private var _boundPort: UInt16?

    public init(config: Config, hostKeyStore: RelayHostKeyStore) {
        self.config = config
        self.keyStore = hostKeyStore
    }

    /// True once Conductor's host is connected and this device is authenticated.
    public var isReady: Bool { lock.withLock { client != nil } }

    /// The port actually bound, once listening.
    public var boundPort: UInt16? { lock.withLock { _boundPort } }

    /// Parses `http://127.0.0.1:<port>`; anything else is not ours.
    static func localPort(from override: String?) -> UInt16? {
        guard let override,
            let m = override.wholeMatch(of: /http:\/\/127\.0\.0\.1:(\d+)/),
            let port = UInt16(m.1)
        else { return nil }
        return port
    }

    public func start() {
        guard let port = Self.localPort(from: config.overrideURL) else { return }  // inert: override not local
        guard config.credentials != nil else { return }  // inert: no paired device
        let hostKey = keyStore.load()
        lock.withLock {
            guard startTask == nil else { return }
            startTask = Task { [self] in await listenWithRetry(port: port, hostKey: hostKey) }
        }
    }

    private func listenWithRetry(port: UInt16, hostKey: Data?) async {
        while !Task.isCancelled, !lock.withLock({ stopped }) {
            let server = RelayServer(
                options: .init(
                    hostStaticPublicKey: hostKey, upstreamBaseURL: config.upstreamBaseURL,
                    onHost: { [weak self] conn in await self?.onHost(conn.client) }))
            do {
                let bound = try await server.listen(port: port)
                let keep = lock.withLock { () -> Bool in
                    if stopped { return false }
                    self.server = server
                    self._boundPort = bound
                    return true
                }
                if !keep { await server.close() }
                return
            } catch {
                await server.close()
                try? await Task.sleep(nanoseconds: UInt64(config.listenRetryInterval * 1_000_000_000))
            }
        }
    }

    private func onHost(_ phone: PhoneClient) async {
        lock.withLock { client = nil }  // a new connection supersedes any previous one
        do {
            try await phone.handshake()
            if let key = phone.hostStaticKey { keyStore.save(key) }
            guard let creds = config.credentials else { return }
            try await phone.authenticate(creds)
            lock.withLock { client = phone }
        } catch {
            lock.withLock { client = nil }
        }
    }

    /// Deliver a message into a Conductor chat through the real composer.
    public func send(workspaceId: String, sessionId: String, text: String, mode: String = "queue") async
        -> RelaySendResult
    {
        guard let phone = lock.withLock({ client }) else { return .failed(reason: "relay not connected") }
        do {
            let res = try await phone.sendChatMessage(
                workspaceLocalId: workspaceId, sessionId: sessionId, text: text, mode: mode)
            if (200..<300).contains(res.status) { return .ok }
            return .failed(reason: "relay HTTP \(res.status)")
        } catch {
            // A dead connection surfaces here; drop it so isReady goes false.
            lock.withLock { client = nil }
            return .failed(reason: (error as? RelayError)?.message ?? String(describing: error))
        }
    }

    public func stop() async {
        let (task, server) = lock.withLock { () -> (Task<Void, Never>?, RelayServer?) in
            stopped = true
            client = nil
            let t = startTask, s = self.server
            startTask = nil
            self.server = nil
            _boundPort = nil
            return (t, s)
        }
        task?.cancel()
        await server?.close()
    }
}
