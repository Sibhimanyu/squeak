import CryptoKit
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

    /// `local`: the direct same-Wi-Fi path (docs/remote-channel.md); nil keeps everything on the cloud.
    public init(pairing: PairingPayload, deviceId: String, transport: HTTPTransport = URLSession.shared, local: LocalSupport? = nil) {
        self.pairing = pairing
        self.deviceId = deviceId
        firestore = FirestoreClient(projectId: pairing.p, transport: transport)
        router = BackendRouter(pairing: pairing, firestore: firestore, transport: transport, streams: Self.streamSession, local: local)
    }

    /// Streams get a session of their own, so a held stream can never take
    /// the connection a presence ping or a command needs (requests use
    /// `URLSession.shared`, a separate pool).
    public static let streamSession: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.httpMaximumConnectionsPerHost = 6
        configuration.timeoutIntervalForRequest = RealtimeDatabaseClient.stallSeconds
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }()

    public init(pairing: PairingPayload, deviceId: String, transport: HTTPTransport = URLSession.shared, streams: LineStreamTransport, local: LocalSupport? = nil) {
        self.pairing = pairing
        self.deviceId = deviceId
        firestore = FirestoreClient(projectId: pairing.p, transport: transport)
        router = BackendRouter(pairing: pairing, firestore: firestore, transport: transport, streams: streams, local: local)
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

    /// What the Mac writes for the phone, over one stream on `state`: the view
    /// and the Mac's answer to presence (the phone's own presence echo is
    /// ignored), with the stream's health. Nil when the channel can only be
    /// polled (Firestore).
    public func stateEvents() async -> AsyncStream<StateEvent>? {
        guard let events = await store.events(in: "channels/\(pairing.c)/state", documents: ["snapshot", "alive", "recent"]) else { return nil }
        let key = pairing.k
        return AsyncStream { continuation in
            let task = Task {
                for await event in events {
                    switch event {
                    case .connected: continuation.yield(.connected)
                    case .dropped: continuation.yield(.dropped)
                    case .heard: continuation.yield(.heard)
                    case .document("snapshot", .value(let document)):
                        // Undecodable is never the end of the stream: the full read says why, and the next view still arrives.
                        if let view = try? document.map({ try ChannelCrypto.open(PhoneSnapshot.self, box: $0.box, key: key) }) {
                            continuation.yield(.snapshot(view))
                        } else {
                            continuation.yield(.needsRead)
                        }
                    case .document("recent", .value(let document)):
                        if let recent = try? document.map({ try ChannelCrypto.open(PhoneRecent.self, box: $0.box, key: key) }) {
                            continuation.yield(.recent(recent))
                        } else {
                            continuation.yield(.needsRead)
                        }
                    case .document("alive", .value(let document)):
                        continuation.yield(.alive(document.flatMap { try? ChannelCrypto.open(MacAlive.self, box: $0.box, key: key) }))
                    case .document(_, .refetch):
                        continuation.yield(.needsRead)
                    case .document:
                        break
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Each open stream's health, for Settings › Connection details.
    public func streamHealth() async -> [StreamHealth] { await store.streamHealth() }

    /// Removes a command's result once read, so it does not wait for the Mac's sweep. Best effort.
    public func deleteResult(_ id: String) async {
        try? await store.delete(path("results", id))
    }

    /// Whether replies and the view travel through the Realtime Database (directly, or through the Mac's local path).
    public var streams: Bool { get async { await router.isStreamed() } }

    /* ---------- the direct path ---------- */

    /// Starts looking for the Mac on the local network (the first time asks for Local Network access). Cheap and
    /// safe to call again; does nothing without `local` support or on a channel that is not on the Realtime Database.
    public func startLocal() async { await router.startLocal() }

    /// Stops probing (the app left the screen).
    public func stopLocal() async { await router.stopLocal() }

    /// The Mac's own list of where it listens, from its sealed view: tried at once when the cloud is in use.
    public func learnLocal(_ info: PhoneSnapshot.LocalEndpointInfo?) async { await router.learnLocal(info) }

    /// The network changed: forget the local route and look again.
    public func networkChanged() async { await router.networkChanged() }

    /// Which way the phone is talking to the Mac right now.
    public func route() async -> ChannelRoute { await router.route() }

    /// The route now and every change to it.
    public func routeUpdates() async -> AsyncStream<ChannelRoute> { await router.routeUpdates() }

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

    /// A session's live turn as it is written, decoded from the stream; nil on Firestore. A Mac
    /// that writes its history apart (`split`) has it folded back in, so the caller sees one turn.
    /// Both documents come over one stream on the `live` collection.
    public func liveTurns(for sessionKey: String) async -> AsyncStream<LiveTurn?>? {
        let handle = LiveTurn.handle(for: sessionKey), historyHandle = LiveTurn.handle(for: sessionKey) + "-h"
        guard let events = await store.events(in: "channels/\(pairing.c)/live", documents: [handle, historyHandle]) else { return nil }
        let key = pairing.k
        return AsyncStream { continuation in
            let task = Task {
                var turn: LiveTurn?
                var history: LiveHistory?
                for await event in events {
                    guard case .document(let name, let change) = event else { continue }
                    if name == handle {
                        switch change {
                        case .value(let document): turn = document.flatMap { try? ChannelCrypto.open(LiveTurn.self, box: $0.box, key: key) }
                        case .refetch: turn = try? await self.liveTurnOnly(handle)
                        }
                        turn = turn?.key == sessionKey ? turn : nil
                    } else {
                        switch change {
                        case .value(let document): history = document.flatMap { try? ChannelCrypto.open(LiveHistory.self, box: $0.box, key: key) }
                        case .refetch: history = try? await self.liveHistory(historyHandle)
                        }
                        history = history?.key == sessionKey ? history : nil
                    }
                    var shown = turn
                    if shown?.split == true { shown?.history = history?.history }
                    continuation.yield(shown)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func liveTurnOnly(_ handle: String) async throws -> LiveTurn? {
        guard let document = try await store.get(path("live", handle)) else { return nil }
        return try ChannelCrypto.open(LiveTurn.self, box: document.box, key: pairing.k)
    }

    private func liveHistory(_ handle: String) async throws -> LiveHistory? {
        guard let document = try await store.get(path("live", handle)) else { return nil }
        return try ChannelCrypto.open(LiveHistory.self, box: document.box, key: pairing.k)
    }

    /// The recent document a split view leaves out (`PhoneSnapshot.split`).
    public func recent() async throws -> PhoneRecent? {
        guard let document = try await store.get(path("state", "recent")) else { return nil }
        return try ChannelCrypto.open(PhoneRecent.self, box: document.box, key: pairing.k)
    }

    public func snapshot() async throws -> PhoneSnapshot? {
        guard let document = try await store.get(path("state", "snapshot")) else { return nil }
        return try ChannelCrypto.open(PhoneSnapshot.self, box: document.box, key: pairing.k)
    }

    /// Tells the Mac a phone is looking, so it polls and publishes faster.
    /// `watching` names the session open on screen, only in verbose mode;
    /// the Mac then publishes its whole turn (`liveTurn`) until it is nil.
    public func touchPresence(watching: String? = nil, recent: Int? = nil, now: Date = Date()) async throws {
        let presence = Presence(at: Int64(now.timeIntervalSince1970 * 1000), watching: watching, recent: recent,
                                caps: ChannelCrypto.capabilities)
        let box = try ChannelCrypto.seal(presence, key: pairing.k)
        try await store.set(path("state", "presence"), ChannelDocument(box: box))
    }

    /// The Mac's last answer to a presence ping, or nil from a Mac that never answers (older).
    public func alive() async throws -> MacAlive? {
        guard let document = try await store.get(path("state", "alive")) else { return nil }
        return try ChannelCrypto.open(MacAlive.self, box: document.box, key: pairing.k)
    }

    /// The Mac's answers as they are written; nil on Firestore (poll `alive`).
    public func alives() async -> AsyncStream<MacAlive?>? {
        guard let documents = await store.documents(path("state", "alive")) else { return nil }
        let key = pairing.k
        return AsyncStream { continuation in
            let task = Task {
                for await change in documents {
                    switch change {
                    case .value(let document):
                        continuation.yield(document.flatMap { try? ChannelCrypto.open(MacAlive.self, box: $0.box, key: key) })
                    case .refetch:
                        continuation.yield(try? await self.alive())
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
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
        messageId: String? = nil,
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
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000),
            messageId: messageId
        )
        let box = try ChannelCrypto.seal(command, key: pairing.k)
        let id = UUID().uuidString.lowercased()
        return (id, ChannelDocument(box: box, sig: try signer.sign(box), device: deviceId))
    }

    /// The signed document asking for an image a chat's agent showed.
    public func imageDocument(sessionId: String, sessionKey: String? = nil, source: String, signer: CommandSigner, now: Date = Date()) throws -> (id: String, document: ChannelDocument) {
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let command = ImageCommand(
            v: 1, kind: "image", sessionId: sessionId, sessionKey: sessionKey, source: source,
            nonce: nonce.map { String(format: "%02x", $0) }.joined(),
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000)
        )
        let box = try ChannelCrypto.seal(command, key: pairing.k)
        let id = UUID().uuidString.lowercased()
        return (id, ChannelDocument(box: box, sig: try signer.sign(box), device: deviceId))
    }

    /// The signed document answering a workflow's call (a film's pick a story, pick a look, its question).
    public func workflowDocument(
        sessionKey: String, workflow: Workflow, type: String, value: WorkflowCommand.Value?, note: String? = nil,
        signer: CommandSigner, now: Date = Date()
    ) throws -> (id: String, document: ChannelDocument) {
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let command = WorkflowCommand(
            v: 1, kind: "workflow", sessionKey: sessionKey, step: workflow.step, revision: workflow.revision,
            type: type, value: value, note: note,
            nonce: nonce.map { String(format: "%02x", $0) }.joined(),
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000)
        )
        let box = try ChannelCrypto.seal(command, key: pairing.k)
        let id = UUID().uuidString.lowercased()
        return (id, ChannelDocument(box: box, sig: try signer.sign(box), device: deviceId))
    }

    /// The signed, read-only document asking for one page of a chat's earlier messages (`HistoryPage`).
    public func historyDocument(key sessionKey: String, before: String?, n: Int = 12, signer: CommandSigner, now: Date = Date()) throws -> (id: String, document: ChannelDocument) {
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let command = HistoryCommand(
            v: 1, kind: "history", key: sessionKey, before: before, n: n,
            nonce: nonce.map { String(format: "%02x", $0) }.joined(),
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000)
        )
        let box = try ChannelCrypto.seal(command, key: pairing.k)
        let id = UUID().uuidString.lowercased()
        return (id, ChannelDocument(box: box, sig: try signer.sign(box), device: deviceId))
    }

    /// The page the Mac left for `historyDocument`, or nil when it is not there (or is not for this chat and cursor).
    public func historyPage(key sessionKey: String, before: String?) async throws -> HistoryPage? {
        let doc = LiveTurn.historyPageDoc(for: sessionKey, before: before)
        guard let document = try await store.get(path("live", doc)) else { return nil }
        let page = try ChannelCrypto.open(HistoryPage.self, box: document.box, key: pairing.k)
        return page.key == sessionKey && page.before == before ? page : nil
    }

    /// The signed, read-only document asking the Mac to follow one subagent of the open chat, or (nil) to stop.
    public func subagentDocument(key sessionKey: String, taskId: String?, signer: CommandSigner, now: Date = Date()) throws -> (id: String, document: ChannelDocument) {
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let command = SubagentCommand(
            key: sessionKey, taskId: taskId,
            nonce: nonce.map { String(format: "%02x", $0) }.joined(),
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000)
        )
        let box = try ChannelCrypto.seal(command, key: pairing.k)
        let id = UUID().uuidString.lowercased()
        return (id, ChannelDocument(box: box, sig: try signer.sign(box), device: deviceId))
    }

    /// The chat's subagent feed as it is written (through the shared stream on `live`); nil on Firestore. Yields nil
    /// when the document goes. A feed for another chat is dropped.
    public func subagentFeeds(for sessionKey: String) async -> AsyncStream<SubagentFeed?>? {
        let name = SubagentFeed.doc(for: sessionKey)
        guard let events = await store.events(in: "channels/\(pairing.c)/live", documents: [name]) else { return nil }
        let key = pairing.k
        return AsyncStream { continuation in
            let task = Task {
                for await event in events {
                    guard case .document(let changed, let change) = event, changed == name else { continue }
                    var feed: SubagentFeed?
                    switch change {
                    case .value(let document): feed = document.flatMap { try? ChannelCrypto.open(SubagentFeed.self, box: $0.box, key: key) }
                    case .refetch:
                        if let backend = Optional(await self.store), let document = try? await backend.get(self.path("live", name)) {
                            feed = try? ChannelCrypto.open(SubagentFeed.self, box: document.box, key: key)
                        }
                    }
                    continuation.yield(feed?.key == sessionKey ? feed : nil)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// The signed document asking for what a film's card plays.
    public func mediaDocument(sessionKey: String, source: String, signer: CommandSigner, now: Date = Date()) throws -> (id: String, document: ChannelDocument) {
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let command = MediaCommand(
            v: 1, kind: "media", sessionKey: sessionKey, source: source,
            nonce: nonce.map { String(format: "%02x", $0) }.joined(),
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000)
        )
        let box = try ChannelCrypto.seal(command, key: pairing.k)
        let id = UUID().uuidString.lowercased()
        return (id, ChannelDocument(box: box, sig: try signer.sign(box), device: deviceId))
    }

    /// A phone copy the Mac left in the channel: every chunk, opened, in order, checked against its hash.
    /// Two at a time, so the stream and a result read still have connections of their own.
    public func media(_ ref: MediaRef) async throws -> Data {
        guard ref.chunks > 0, ref.chunks <= 400, ref.id.range(of: "^[A-Za-z0-9]{8,64}$", options: .regularExpression) != nil else {
            throw ChannelCrypto.Failure.badBox
        }
        var parts = [Data?](repeating: nil, count: ref.chunks)
        var next = 0
        while next < ref.chunks {
            let batch = Array(next..<min(next + 2, ref.chunks))
            next += batch.count
            try await withThrowingTaskGroup(of: (Int, Data).self) { group in
                for index in batch {
                    group.addTask { [self] in
                        guard let document = try await store.get(path("media", "\(ref.id)-\(index)")) else {
                            throw ChannelCrypto.Failure.badBox
                        }
                        let chunk = try ChannelCrypto.open(MediaChunk.self, box: document.box, key: pairing.k)
                        guard chunk.i == index, chunk.n == ref.chunks, let data = Data(base64Encoded: chunk.data) else {
                            throw ChannelCrypto.Failure.badBox
                        }
                        return (index, data)
                    }
                }
                for try await (index, data) in group { parts[index] = data }
            }
        }
        var joined = Data(capacity: ref.bytes)
        for part in parts {
            guard let part else { throw ChannelCrypto.Failure.badBox }
            joined.append(part)
        }
        guard joined.count == ref.bytes, SHA256.hash(data: joined).map({ String(format: "%02x", $0) }).joined() == ref.sha256 else {
            throw ChannelCrypto.Failure.badBox
        }
        return joined
    }

    /// The signed document asking what a chat changed (and one file's patch).
    public func diffDocument(sessionId: String, file: Int?, signer: CommandSigner, now: Date = Date()) throws -> (id: String, document: ChannelDocument) {
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let command = DiffCommand(
            v: 1, kind: "diff", sessionId: sessionId, file: file,
            nonce: nonce.map { String(format: "%02x", $0) }.joined(),
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000)
        )
        let box = try ChannelCrypto.seal(command, key: pairing.k)
        let id = UUID().uuidString.lowercased()
        return (id, ChannelDocument(box: box, sig: try signer.sign(box), device: deviceId))
    }

    /// The signed document that stops a working chat's turn.
    public func stopDocument(to session: PhoneSnapshot.Session, signer: CommandSigner, now: Date = Date()) throws -> (id: String, document: ChannelDocument) {
        guard let sessionId = session.conductorSessionId else { throw ChannelCrypto.Failure.badBox }
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let command = StopCommand(
            v: 1,
            kind: "stop",
            sessionId: sessionId,
            answersTurn: session.turnId,
            nonce: nonce.map { String(format: "%02x", $0) }.joined(),
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000)
        )
        let box = try ChannelCrypto.seal(command, key: pairing.k)
        let id = UUID().uuidString.lowercased()
        return (id, ChannelDocument(box: box, sig: try signer.sign(box), device: deviceId))
    }

    /// The signed document for one chunk of a photo, for a chat (`sessionId`) or a new chat's workspace.
    public func attachDocument(
        sessionId: String? = nil,
        workspaceId: String? = nil,
        uploadId: String,
        index: Int,
        total: Int,
        chunk: Data,
        signer: CommandSigner,
        now: Date = Date()
    ) throws -> (id: String, document: ChannelDocument) {
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let command = AttachCommand(
            v: 1,
            kind: "attach",
            sessionId: sessionId,
            workspaceId: workspaceId,
            uploadId: uploadId,
            index: index,
            total: total,
            data: chunk.base64EncodedString(),
            nonce: nonce.map { String(format: "%02x", $0) }.joined(),
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000)
        )
        let box = try ChannelCrypto.seal(command, key: pairing.k)
        let id = UUID().uuidString.lowercased()
        return (id, ChannelDocument(box: box, sig: try signer.sign(box), device: deviceId))
    }

    /// The signed document that gives a chat a new name.
    public func renameDocument(to session: PhoneSnapshot.Session, title: String, signer: CommandSigner, now: Date = Date()) throws -> (id: String, document: ChannelDocument) {
        guard let sessionId = session.conductorSessionId else { throw ChannelCrypto.Failure.badBox }
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let command = RenameCommand(
            v: 1,
            kind: "rename",
            sessionId: sessionId,
            title: title,
            nonce: nonce.map { String(format: "%02x", $0) }.joined(),
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000)
        )
        let box = try ChannelCrypto.seal(command, key: pairing.k)
        let id = UUID().uuidString.lowercased()
        return (id, ChannelDocument(box: box, sig: try signer.sign(box), device: deviceId))
    }

    /// The signed document for a workspace action: archive one, make one in a repository, or ask a chat for a PR.
    public func workspaceDocument(action: String, workspaceId: String? = nil, repoId: String? = nil,
                                  session: PhoneSnapshot.Session? = nil,
                                  signer: CommandSigner, now: Date = Date()) throws -> (id: String, document: ChannelDocument) {
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let command = WorkspaceCommand(
            v: 1,
            kind: "workspace",
            action: action,
            workspaceId: workspaceId,
            repoId: repoId,
            sessionId: session?.conductorSessionId,
            answersTurn: session?.turnId,
            nonce: nonce.map { String(format: "%02x", $0) }.joined(),
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000)
        )
        let box = try ChannelCrypto.seal(command, key: pairing.k)
        let id = UUID().uuidString.lowercased()
        return (id, ChannelDocument(box: box, sig: try signer.sign(box), device: deviceId))
    }

    /// The signed document that changes a chat's model, thinking level or fast mode.
    public func setupDocument(to session: PhoneSnapshot.Session, model: String, thinking: String?, fast: Bool?,
                              signer: CommandSigner, now: Date = Date()) throws -> (id: String, document: ChannelDocument) {
        guard let sessionId = session.conductorSessionId else { throw ChannelCrypto.Failure.badBox }
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let command = SetupCommand(
            v: 1,
            kind: "setup",
            sessionId: sessionId,
            model: model,
            thinking: thinking,
            fast: fast,
            nonce: nonce.map { String(format: "%02x", $0) }.joined(),
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000)
        )
        let box = try ChannelCrypto.seal(command, key: pairing.k)
        let id = UUID().uuidString.lowercased()
        return (id, ChannelDocument(box: box, sig: try signer.sign(box), device: deviceId))
    }

    /// The signed document that closes a chat's tab in Conductor.
    public func closeDocument(to session: PhoneSnapshot.Session, signer: CommandSigner, now: Date = Date()) throws -> (id: String, document: ChannelDocument) {
        guard let sessionId = session.conductorSessionId else { throw ChannelCrypto.Failure.badBox }
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let command = CloseCommand(
            v: 1,
            kind: "close",
            sessionId: sessionId,
            nonce: nonce.map { String(format: "%02x", $0) }.joined(),
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000)
        )
        let box = try ChannelCrypto.seal(command, key: pairing.k)
        let id = UUID().uuidString.lowercased()
        return (id, ChannelDocument(box: box, sig: try signer.sign(box), device: deviceId))
    }

    /// The signed document that steers a queued message now (`promote`) or takes it out of the queue (`cancel`).
    public func queueDocument(
        sessionId: String,
        messageId: String,
        action: QueueCommand.Action,
        signer: CommandSigner,
        now: Date = Date()
    ) throws -> (id: String, document: ChannelDocument) {
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let command = QueueCommand(
            v: 1,
            kind: "queue",
            sessionId: sessionId,
            messageId: messageId,
            action: action,
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
        model: String? = nil,
        thinking: String? = nil,
        split: WorkSplit? = nil,
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
            model: model,
            thinking: thinking,
            split: split.flatMap { $0.isEmpty ? nil : $0 },
            nonce: nonce.map { String(format: "%02x", $0) }.joined(),
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000)
        )
        let box = try ChannelCrypto.seal(command, key: pairing.k)
        let id = UUID().uuidString.lowercased()
        return (id, ChannelDocument(box: box, sig: try signer.sign(box), device: deviceId))
    }

    /// The signed document asking the Mac for a fresh Claude usage reading.
    public func usageDocument(signer: CommandSigner, now: Date = Date()) throws -> (id: String, document: ChannelDocument) {
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let command = UsageCommand(
            v: 1,
            kind: "usage",
            nonce: nonce.map { String(format: "%02x", $0) }.joined(),
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000)
        )
        let box = try ChannelCrypto.seal(command, key: pairing.k)
        let id = UUID().uuidString.lowercased()
        return (id, ChannelDocument(box: box, sig: try signer.sign(box), device: deviceId))
    }

    /// The signed document answering the question `toolUseId` in a chat (ANSWER-CARD).
    public func answerDocument(
        sessionId: String,
        toolUseId: String,
        answers: [AnswerCommand.Answer]?,
        plan: AnswerCommand.PlanAnswer? = nil,
        signer: CommandSigner,
        now: Date = Date()
    ) throws -> (id: String, document: ChannelDocument) {
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let command = AnswerCommand(
            v: 1,
            kind: "answer",
            sessionId: sessionId,
            toolUseId: toolUseId,
            answers: answers,
            plan: plan,
            nonce: nonce.map { String(format: "%02x", $0) }.joined(),
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000)
        )
        let box = try ChannelCrypto.seal(command, key: pairing.k)
        let id = UUID().uuidString.lowercased()
        return (id, ChannelDocument(box: box, sig: try signer.sign(box), device: deviceId))
    }

    /// The signed document for hotspot failover: `configure` (name, password, on/off), `join` or `leave`.
    public func hotspotDocument(
        action: HotspotCommand.Action, ssid: String? = nil, password: String? = nil, enabled: Bool? = nil,
        signer: CommandSigner, now: Date = Date()
    ) throws -> (id: String, document: ChannelDocument) {
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let command = HotspotCommand(
            v: 1, kind: "hotspot", action: action, ssid: ssid, password: password, enabled: enabled,
            nonce: nonce.map { String(format: "%02x", $0) }.joined(),
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000)
        )
        let box = try ChannelCrypto.seal(command, key: pairing.k)
        let id = UUID().uuidString.lowercased()
        return (id, ChannelDocument(box: box, sig: try signer.sign(box), device: deviceId))
    }

    /// The signed document changing the Mac's awake session: `on` false ends it; true starts one for
    /// `minutes` (nil: until ended), or with `extend` adds that many minutes to the running one.
    public func awakeDocument(
        on: Bool, minutes: Int? = nil, extend: Int? = nil, lid: Bool? = nil, signer: CommandSigner, now: Date = Date()
    ) throws -> (id: String, document: ChannelDocument) {
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let command = AwakeCommand(
            v: 1,
            kind: "awake",
            on: on,
            minutes: minutes,
            extend: extend,
            lid: lid,
            nonce: nonce.map { String(format: "%02x", $0) }.joined(),
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000)
        )
        let box = try ChannelCrypto.seal(command, key: pairing.k)
        let id = UUID().uuidString.lowercased()
        return (id, ChannelDocument(box: box, sig: try signer.sign(box), device: deviceId))
    }

    /// The signed document for one live control of the Mac (volume, mute, brightness, fans, screen off).
    public func controlsDocument(
        _ change: ControlsCommand.Change, signer: CommandSigner, now: Date = Date()
    ) throws -> (id: String, document: ChannelDocument) {
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let command = ControlsCommand(
            v: 1, kind: "controls", change: change,
            nonce: nonce.map { String(format: "%02x", $0) }.joined(),
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000)
        )
        let box = try ChannelCrypto.seal(command, key: pairing.k)
        let id = UUID().uuidString.lowercased()
        return (id, ChannelDocument(box: box, sig: try signer.sign(box), device: deviceId))
    }

    /// The signed document changing one notification setting of one channel ("telegram" or "cliq").
    public func notifyDocument(
        channel: String, _ change: NotifyChange, signer: CommandSigner, now: Date = Date()
    ) throws -> (id: String, document: ChannelDocument) {
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let command = NotifyCommand(
            v: 1, kind: "notify", channel: channel, change: change,
            nonce: nonce.map { String(format: "%02x", $0) }.joined(),
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000)
        )
        let box = try ChannelCrypto.seal(command, key: pairing.k)
        let id = UUID().uuidString.lowercased()
        return (id, ChannelDocument(box: box, sig: try signer.sign(box), device: deviceId))
    }

    /// The signed document changing what a closed lid does (or, with `open`, what a session does while the lid
    /// is open): only the switches given are changed.
    public func lidActionsDocument(
        _ settings: LidActionsCommand.Settings, open: Bool = false, signer: CommandSigner, now: Date = Date()
    ) throws -> (id: String, document: ChannelDocument) {
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let command = LidActionsCommand(
            v: 1, kind: "lidActions", mode: open ? "open" : nil, settings: settings,
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

    /// Takes a command back before the Mac reads it. True when it is gone from the channel, so it can never
    /// run; false when that could not be done (offline), which proves nothing either way.
    public func deleteCommand(_ id: String) async -> Bool {
        do { try await store.delete(path("commands", id)); return true } catch { return false }
    }

    public func result(for id: String) async throws -> CommandResult? {
        guard let document = try await store.get(path("results", id)) else { return nil }
        return try ChannelCrypto.open(CommandResult.self, box: document.box, key: pairing.k)
    }
}

/// One thing the state stream says (`Channel.stateEvents`).
public enum StateEvent: Equatable, Sendable {
    case connected
    case dropped
    /// The server was heard from: any event, keep-alives included.
    case heard
    case snapshot(PhoneSnapshot?)
    /// The recent list and workspaces a split view leaves out.
    case recent(PhoneRecent?)
    case alive(MacAlive?)
    /// A change the event did not carry whole, or could not be opened: read it.
    case needsRead
}

/// Picks where this channel's documents are: the Realtime Database named in
/// the pairing code, else the one the Mac announced in the sealed
/// `state/transport` Firestore document (a phone paired before the move),
/// else Firestore. The announcement is re-checked every few minutes while on
/// Firestore, so a Mac that moves later is followed without re-pairing.
///
/// On the Realtime Database, with `local` support, the backend it hands out is
/// a `RoutedBackend`: the direct same-Wi-Fi path when a probe finds the Mac,
/// the cloud otherwise and at once on any local failure.
actor BackendRouter {
    private let pairing: PairingPayload
    private let firestore: FirestoreClient
    private let transport: HTTPTransport
    private let streams: LineStreamTransport
    private let local: LocalRouter?
    private var chosen: ChannelBackend?
    private var routed: ChannelBackend?
    private var checkedAt: Date?
    private var localStarted = false

    static let recheck: TimeInterval = 5 * 60

    init(pairing: PairingPayload, firestore: FirestoreClient, transport: HTTPTransport, streams: LineStreamTransport, local: LocalSupport? = nil) {
        self.pairing = pairing
        self.firestore = firestore
        self.transport = transport
        self.streams = streams
        self.local = local.flatMap { LocalRouter.make(pairing: pairing, support: $0) }
    }

    func backend(now: Date = Date()) async -> ChannelBackend {
        let cloud = await cloudBackend(now: now)
        guard let local, cloud is RealtimeDatabaseClient else { return cloud }
        if let routed { return routed }
        let backend = RoutedBackend(cloud: cloud, router: local)
        routed = backend
        return backend
    }

    func isStreamed() async -> Bool { await cloudBackend() is RealtimeDatabaseClient }

    func startLocal() async {
        guard let local, await cloudBackend() is RealtimeDatabaseClient else { return }
        localStarted = true
        await local.start()
    }

    func stopLocal() async {
        localStarted = false
        await local?.stop()
    }

    func learnLocal(_ info: PhoneSnapshot.LocalEndpointInfo?) async {
        guard let local, localStarted else { return }
        await local.learn(hints: LocalEndpointHints.urls(info, expectedTag: LocalAuth.tag(channelKey: pairing.k)))
    }

    func networkChanged() async { await local?.networkChanged() }
    func route() async -> ChannelRoute { await local?.route ?? .cloud }

    func routeUpdates() async -> AsyncStream<ChannelRoute> {
        guard let local else { return AsyncStream { $0.yield(.cloud); $0.finish() } }
        let updates = await local.updates()
        return AsyncStream { continuation in
            let task = Task {
                var last: ChannelRoute?
                for await update in updates where update.route != last {
                    last = update.route
                    continuation.yield(update.route)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func cloudBackend(now: Date = Date()) async -> ChannelBackend {
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
