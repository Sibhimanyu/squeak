import Foundation

/// A paired phone's side of the channel: read the Mac's view, say it is
/// open, ask to pair, and send signed replies. Paths and formats mirror
/// src/remote/remote-bridge.ts.
public struct Channel: Sendable {
    public let pairing: PairingPayload
    public let deviceId: String
    let firestore: FirestoreClient
    let router: BackendRouter

    /// Commands live a few minutes: long enough for a slow network, short
    /// enough that a stale one is refused (the Mac caps it at ten).
    public static let commandLifetime: TimeInterval = 5 * 60

    public init(pairing: PairingPayload, deviceId: String, transport: HTTPTransport = URLSession.shared) {
        self.pairing = pairing
        self.deviceId = deviceId
        firestore = FirestoreClient(projectId: pairing.p, transport: transport)
        router = BackendRouter(pairing: pairing, firestore: firestore, transport: transport, streams: URLSession.shared)
    }

    public init(pairing: PairingPayload, deviceId: String, transport: HTTPTransport = URLSession.shared, streams: LineStreamTransport) {
        self.pairing = pairing
        self.deviceId = deviceId
        firestore = FirestoreClient(projectId: pairing.p, transport: transport)
        router = BackendRouter(pairing: pairing, firestore: firestore, transport: transport, streams: streams)
    }

    func path(_ kind: String, _ id: String) -> String { "channels/\(pairing.c)/\(kind)/\(id)" }

    private var store: ChannelBackend { get async { await router.backend() } }

    /// Yields when the Mac writes a new view, or nil when the channel can only
    /// be polled (Firestore). The caller still reads with `snapshot()`.
    public func snapshotChanges() async -> AsyncStream<Void>? {
        await store.changes(path("state", "snapshot"))
    }

    /// Yields when the Mac writes any result: a reply's outcome or a pairing answer.
    public func resultChanges() async -> AsyncStream<Void>? {
        await store.changes("channels/\(pairing.c)/results")
    }

    /// Whether replies and the view travel through the Realtime Database.
    public var streams: Bool { get async { await store is RealtimeDatabaseClient } }

    /// A Realtime Database instance URL, and nothing else: the phone will send
    /// signed commands there, so a pairing code or the sealed transport
    /// document must not be able to aim it at another host.
    public static func isDatabaseURL(_ text: String) -> Bool {
        guard let url = URL(string: text), url.scheme == "https", url.query == nil, let host = url.host?.lowercased() else { return false }
        return host.hasSuffix(".firebasedatabase.app") || host.hasSuffix(".firebaseio.com")
    }

    /// The Mac's view as it is written, decoded from the stream itself (no
    /// second download), or nil when the channel can only be polled. A
    /// partial change is re-read.
    public func snapshots() async -> AsyncThrowingStream<PhoneSnapshot?, Error>? {
        guard let documents = await store.documents(path("state", "snapshot")) else { return nil }
        let key = pairing.k
        return AsyncThrowingStream { continuation in
            let task = Task {
                for await change in documents {
                    do {
                        switch change {
                        case .value(let document):
                            continuation.yield(try document.map { try ChannelCrypto.open(PhoneSnapshot.self, box: $0.box, key: key) })
                        case .refetch:
                            continuation.yield(try await self.snapshot())
                        }
                    } catch {
                        continuation.finish(throwing: error)
                        return
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// A session's live turn as it is written, decoded from the stream; nil on Firestore.
    public func liveTurns(for sessionKey: String) async -> AsyncStream<LiveTurn?>? {
        guard let documents = await store.documents(path("live", LiveTurn.handle(for: sessionKey))) else { return nil }
        let key = pairing.k
        return AsyncStream { continuation in
            let task = Task {
                for await change in documents {
                    let turn: LiveTurn?
                    switch change {
                    case .value(let document):
                        turn = document.flatMap { try? ChannelCrypto.open(LiveTurn.self, box: $0.box, key: key) }
                    case .refetch:
                        turn = try? await self.liveTurn(for: sessionKey)
                    }
                    continuation.yield(turn?.key == sessionKey ? turn : nil)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func snapshot() async throws -> PhoneSnapshot? {
        guard let document = try await store.get(path("state", "snapshot")) else { return nil }
        return try ChannelCrypto.open(PhoneSnapshot.self, box: document.box, key: pairing.k)
    }

    /// Tells the Mac a phone is looking, so it polls and publishes faster.
    /// `watching` names the session open on screen, only in verbose mode;
    /// the Mac then publishes its whole turn (`liveTurn`) until it is nil.
    public func touchPresence(watching: String? = nil, now: Date = Date()) async throws {
        let presence = Presence(at: Int64(now.timeIntervalSince1970 * 1000), watching: watching)
        let box = try ChannelCrypto.seal(presence, key: pairing.k)
        try await store.set(path("state", "presence"), ChannelDocument(box: box))
    }

    /// The verbose view of a session, while this phone's presence names it.
    public func liveTurn(for sessionKey: String) async throws -> LiveTurn? {
        guard let document = try await store.get(path("live", LiveTurn.handle(for: sessionKey))) else { return nil }
        let turn = try ChannelCrypto.open(LiveTurn.self, box: document.box, key: pairing.k)
        return turn.key == sessionKey ? turn : nil
    }

    /// Yields when the Mac rewrites that session's live turn; nil on Firestore (poll `liveTurn`).
    public func liveChanges(for sessionKey: String) async -> AsyncStream<Void>? {
        await store.changes(path("live", LiveTurn.handle(for: sessionKey)))
    }

    public func requestPairing(name: String, signer: CommandSigner) async throws {
        struct Request: Codable { let name: String; let publicKey: String }
        let box = try ChannelCrypto.seal(Request(name: name, publicKey: signer.publicKeyX963.base64EncodedString()), key: pairing.k)
        try await store.set(path("pairing", deviceId), ChannelDocument(box: box))
    }

    public func pairingAnswer() async throws -> PairingAnswer? {
        guard let document = try await store.get(path("results", "pair-\(deviceId)")) else { return nil }
        return try ChannelCrypto.open(PairingAnswer.self, box: document.box, key: pairing.k)
    }

    /// The signed document for a reply. Separate from sending so it can be
    /// checked against the Mac's verifier in tests.
    public func replyDocument(
        to session: PhoneSnapshot.Session,
        text: String,
        mode: ReplyMode = .queue,
        signer: CommandSigner,
        now: Date = Date()
    ) throws -> (id: String, document: ChannelDocument) {
        guard let sessionId = session.conductorSessionId else { throw ChannelCrypto.Failure.badBox }
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let command = ReplyCommand(
            v: 1,
            sessionId: sessionId,
            answersTurn: session.turnId,
            text: text,
            // A queued reply carries no mode at all, byte-identical to before.
            mode: mode == .steer ? .steer : nil,
            nonce: nonce.map { String(format: "%02x", $0) }.joined(),
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000)
        )
        let box = try ChannelCrypto.seal(command, key: pairing.k)
        let id = UUID().uuidString.lowercased()
        return (id, ChannelDocument(box: box, sig: try signer.sign(box), device: deviceId))
    }

    /// The signed document for starting a new chat in `workspace`. Same envelope and
    /// signature as a reply; `kind: "start"` is what the Mac dispatches on.
    public func startDocument(
        workspaceId: String,
        agent: NewChatAgent,
        text: String,
        signer: CommandSigner,
        now: Date = Date()
    ) throws -> (id: String, document: ChannelDocument) {
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let command = StartCommand(
            v: 1,
            kind: "start",
            workspaceId: workspaceId,
            agent: agent,
            text: text,
            nonce: nonce.map { String(format: "%02x", $0) }.joined(),
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000)
        )
        let box = try ChannelCrypto.seal(command, key: pairing.k)
        let id = UUID().uuidString.lowercased()
        return (id, ChannelDocument(box: box, sig: try signer.sign(box), device: deviceId))
    }

    public func send(_ document: ChannelDocument, id: String) async throws {
        try await store.set(path("commands", id), document)
    }

    public func result(for id: String) async throws -> CommandResult? {
        guard let document = try await store.get(path("results", id)) else { return nil }
        return try ChannelCrypto.open(CommandResult.self, box: document.box, key: pairing.k)
    }
}

/// Picks where this channel's documents are: the Realtime Database named in
/// the pairing code, else the one the Mac announced in the sealed
/// `state/transport` Firestore document (a phone paired before the move),
/// else Firestore. The announcement is re-checked every few minutes while on
/// Firestore, so a Mac that moves later is followed without re-pairing.
actor BackendRouter {
    private let pairing: PairingPayload
    private let firestore: FirestoreClient
    private let transport: HTTPTransport
    private let streams: LineStreamTransport
    private var chosen: ChannelBackend?
    private var checkedAt: Date?

    static let recheck: TimeInterval = 5 * 60

    init(pairing: PairingPayload, firestore: FirestoreClient, transport: HTTPTransport, streams: LineStreamTransport) {
        self.pairing = pairing
        self.firestore = firestore
        self.transport = transport
        self.streams = streams
    }

    func backend(now: Date = Date()) async -> ChannelBackend {
        if let chosen, chosen is RealtimeDatabaseClient { return chosen }
        if let url = pairing.r { return use(url) }
        if let checkedAt, now.timeIntervalSince(checkedAt) < Self.recheck, let chosen { return chosen }
        struct Transport: Codable { let r: String }
        let document: ChannelDocument?
        do {
            document = try await firestore.get("channels/\(pairing.c)/state/transport")
        } catch {
            // Offline or a blip: answer with Firestore this once and ask again next time.
            return chosen ?? firestore
        }
        checkedAt = now
        if let document,
           let announced = try? ChannelCrypto.open(Transport.self, box: document.box, key: pairing.k),
           Channel.isDatabaseURL(announced.r) {
            return use(announced.r)
        }
        chosen = firestore
        return firestore
    }

    private func use(_ url: String) -> ChannelBackend {
        let client = RealtimeDatabaseClient(databaseURL: url, transport: transport, streams: streams)
        chosen = client
        return client
    }
}
