import Foundation

/// Which way the phone is talking to its Mac: the direct same-Wi-Fi path, or the cloud (Realtime Database).
public enum ChannelRoute: Equatable, Sendable {
    case cloud
    case local
}

/// Where the Mac may be found without Bonjour's help or with it: URLs like `http://192.168.1.20:51234`.
public protocol LocalDiscovery: Sendable {
    /// Addresses of a Mac advertising this tag right now (nothing found: empty). Takes about a second at most.
    func candidates(tag: String) async -> [URL]
}

/// The rules for choosing a route, with no I/O so they can be tested by feeding them events and a clock.
///
/// Local is preferred whenever a probe succeeds. Any failure of a real call, or two missed heartbeats, goes
/// back to the cloud at once; from there local is probed again every 30 seconds, and at once when the network
/// changes or the Mac's address becomes known.
public struct RouteMachine: Equatable, Sendable {
    public private(set) var route: ChannelRoute = .cloud
    public private(set) var endpoint: URL?
    public private(set) var nextProbeAt: Date = .distantPast
    public private(set) var nextHeartbeatAt: Date = .distantFuture
    var heartbeatMisses = 0

    public static let reprobeSeconds: TimeInterval = 30
    public static let heartbeatSeconds: TimeInterval = 5
    /// Consecutive missed heartbeats before a quiet local path is given up (a real call failing is enough on its own).
    static let heartbeatLimit = 2

    public init() {}

    public func shouldProbe(now: Date) -> Bool { route == .cloud && now >= nextProbeAt }
    public func shouldHeartbeat(now: Date) -> Bool { route == .local && now >= nextHeartbeatAt }

    public mutating func probeSucceeded(_ url: URL, now: Date) {
        route = .local; endpoint = url; heartbeatMisses = 0
        nextHeartbeatAt = now.addingTimeInterval(Self.heartbeatSeconds)
    }

    public mutating func probeFailed(now: Date) {
        nextProbeAt = now.addingTimeInterval(Self.reprobeSeconds)
    }

    /// A get, set or delete (or a stream) on the local path failed or timed out.
    public mutating func operationFailed(now: Date) {
        guard route == .local else { return }
        demote(now: now)
    }

    public mutating func heartbeat(ok: Bool, now: Date) {
        nextHeartbeatAt = now.addingTimeInterval(Self.heartbeatSeconds)
        if ok { heartbeatMisses = 0; return }
        heartbeatMisses += 1
        if heartbeatMisses >= Self.heartbeatLimit { demote(now: now) }
    }

    /// Wi-Fi changed (or came back): what was reachable may not be, and what was not may be.
    public mutating func networkChanged(now: Date) {
        route = .cloud; endpoint = nil; heartbeatMisses = 0
        nextProbeAt = now
        nextHeartbeatAt = .distantFuture
    }

    /// The app came back on screen: confirm a local route soon rather than trust one from before it left.
    public mutating func checkSoon(now: Date) {
        if route == .local { nextHeartbeatAt = now }
    }

    /// A new address for the Mac: try it now, if the cloud is what is in use.
    public mutating func addressLearned(now: Date) {
        if route == .cloud { nextProbeAt = min(nextProbeAt, now) }
    }

    private mutating func demote(now: Date) {
        route = .cloud; endpoint = nil; heartbeatMisses = 0
        nextProbeAt = now.addingTimeInterval(Self.reprobeSeconds)
        nextHeartbeatAt = .distantFuture
    }
}

/// What a route change tells the streams that follow it.
public struct ActiveRoute: Sendable {
    public let route: ChannelRoute
    public let url: URL?
    let backend: ChannelBackend?
}

/// Runs the route machine: probes, heartbeats, and the backend for the endpoint in use.
actor LocalRouter {
    private var machine = RouteMachine()
    private var backend: ChannelBackend?
    private var hints: [URL] = []
    private var watchers: [UUID: AsyncStream<ActiveRoute>.Continuation] = [:]
    private var supervisor: Task<Void, Never>?
    private var busy = false
    private var sent: [String: ChannelRoute] = [:]
    private var sentOrder: [String] = []

    private let channelId: String
    private let tag: String
    private let discovery: LocalDiscovery
    private let makeBackend: @Sendable (URL) -> ChannelBackend
    private let probeTransport: @Sendable (URL) -> HTTPTransport
    private let now: @Sendable () -> Date

    init(channelId: String, tag: String, discovery: LocalDiscovery, now: @escaping @Sendable () -> Date = Date.init,
         probeTransport: @escaping @Sendable (URL) -> HTTPTransport,
         makeBackend: @escaping @Sendable (URL) -> ChannelBackend) {
        self.channelId = channelId; self.tag = tag; self.discovery = discovery; self.now = now
        self.probeTransport = probeTransport; self.makeBackend = makeBackend
    }

    /// The router for a paired channel on a phone, or nil when the channel key is not usable.
    static func make(pairing: PairingPayload, support: LocalSupport) -> LocalRouter? {
        guard let signer = try? LocalSigner(channelKey: pairing.k, channelId: pairing.c, now: support.now),
              let tag = LocalAuth.tag(channelKey: pairing.k) else { return nil }
        return LocalRouter(
            channelId: pairing.c, tag: tag, discovery: support.discovery, now: support.now,
            probeTransport: { _ in LocalHTTPTransport(signer: signer, inner: support.requests, timeout: LocalHTTPTransport.probeSeconds) },
            makeBackend: { url in
                RealtimeDatabaseClient(
                    databaseURL: url.absoluteString,
                    transport: LocalHTTPTransport(signer: signer, inner: support.requests),
                    streams: LocalLineStream(signer: signer, inner: support.streams)
                )
            })
    }

    /* ---------- state ---------- */

    var route: ChannelRoute { machine.route }
    var endpoint: URL? { machine.endpoint }
    func active() -> (backend: ChannelBackend, url: URL)? {
        guard machine.route == .local, let backend, let url = machine.endpoint else { return nil }
        return (backend, url)
    }

    /// The route now, and every change after it.
    func updates() -> AsyncStream<ActiveRoute> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<ActiveRoute>.makeStream(bufferingPolicy: .bufferingNewest(8))
        continuation.yield(current())
        watchers[id] = continuation
        continuation.onTermination = { [weak self] _ in Task { await self?.forget(id) } }
        return stream
    }

    private func forget(_ id: UUID) { watchers[id] = nil }

    private func current() -> ActiveRoute {
        ActiveRoute(route: machine.route, url: machine.endpoint, backend: machine.route == .local ? backend : nil)
    }

    private func broadcast() {
        let update = current()
        for watcher in watchers.values { watcher.yield(update) }
    }

    /* ---------- running ---------- */

    func start() {
        machine.checkSoon(now: now())
        guard supervisor == nil else { return }
        supervisor = Task { [weak self] in
            while !Task.isCancelled {
                await self?.tick()
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    func stop() {
        supervisor?.cancel()
        supervisor = nil
    }

    /// One look at what is due: a probe when on the cloud, a heartbeat when on local.
    func tick() async {
        guard !busy else { return }
        let at = now()
        if machine.shouldProbe(now: at) {
            busy = true
            defer { busy = false }
            await probe()
        } else if machine.shouldHeartbeat(now: at), let backend {
            busy = true
            defer { busy = false }
            let ok = await Self.reachable(backend, channelId: channelId)
            let before = machine.route
            machine.heartbeat(ok: ok, now: now())
            if before != machine.route { dropBackend() }
        }
    }

    /// A signed read the Mac answers with its own MAC. A document that is not there is still an answer; only a throw is a miss.
    private static func reachable(_ backend: ChannelBackend, channelId: String) async -> Bool {
        do { _ = try await backend.get("channels/\(channelId)/state/alive"); return true } catch { return false }
    }

    private func probe() async {
        var candidates = hints
        let found = await discovery.candidates(tag: tag)
        for url in found where !candidates.contains(url) { candidates.append(url) }
        guard !candidates.isEmpty else {
            machine.probeFailed(now: now())
            return
        }
        let channelId = channelId, probeTransport = probeTransport
        let winner: URL? = await withTaskGroup(of: URL?.self) { group in
            for url in candidates {
                group.addTask {
                    let client = RealtimeDatabaseClient(databaseURL: url.absoluteString, transport: probeTransport(url), streams: NoStreams())
                    // A signed read the Mac answers with its own MAC: proves reachability and that it is the Mac.
                    return await Self.reachable(client, channelId: channelId) ? url : nil
                }
            }
            for await result in group {
                if let result { group.cancelAll(); return result }
            }
            return nil
        }
        if let winner {
            adopt(winner)
        } else {
            machine.probeFailed(now: now())
        }
    }

    private func adopt(_ url: URL) {
        backend = makeBackend(url)
        machine.probeSucceeded(url, now: now())
        broadcast()
    }

    private func dropBackend() {
        backend = nil
        broadcast()
    }

    /// The Mac's addresses from its own view. A change is tried at once if the cloud is in use.
    func learn(hints next: [URL]) {
        guard next != hints else { return }
        hints = next
        machine.addressLearned(now: now())
    }

    /// Wi-Fi changed: nothing about the old route can be trusted.
    func networkChanged() {
        let wasLocal = machine.route == .local
        machine.networkChanged(now: now())
        if wasLocal { dropBackend() }
    }

    /// A real call on the local path failed or timed out: back to the cloud, now.
    func operationFailed() {
        let before = machine.route
        machine.operationFailed(now: now())
        if before != machine.route { dropBackend() }
    }

    /// Runs one due probe or heartbeat now (tests and a new network drive this by hand).
    func probeNow() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        await probe()
    }

    /* ---------- which way a command went ---------- */

    func noteSent(_ id: String, via route: ChannelRoute) {
        if sent[id] == nil { sentOrder.append(id) }
        sent[id] = route
        if sentOrder.count > 300, let oldest = sentOrder.first {
            sentOrder.removeFirst()
            sent[oldest] = nil
        }
    }

    func sentRoute(_ id: String) -> ChannelRoute? { sent[id] }
}

/// A backend that cannot stream: what a probe uses, since it only reads.
private struct NoStreams: LineStreamTransport {
    func lines(for request: URLRequest) async throws -> AsyncThrowingStream<String, Error> { throw LocalFailure.notHTTP }
}

/// The channel's backend with the direct path folded in. Reads and writes go to the local path while it is
/// the route and to the cloud otherwise; any local failure falls back to the cloud at once. Commands go out
/// on exactly one transport (see `set`). Pairing and media are the cloud's alone.
struct RoutedBackend: ChannelBackend {
    let cloud: ChannelBackend
    let router: LocalRouter

    /// What the Mac mirrors for the direct path (local-channel.ts): the documents a phone reads and the
    /// presence and commands it writes. Everything else (pairing, a film's chunks) is cloud-only.
    static func isLocalKind(_ path: String) -> Bool {
        let parts = path.split(separator: "/")
        guard parts.count >= 3, parts[0] == "channels" else { return false }
        return ["state", "results", "live", "commands"].contains(String(parts[2]))
    }

    static func commandId(_ path: String) -> String? {
        let parts = path.split(separator: "/")
        return parts.count == 4 && parts[2] == "commands" ? String(parts[3]) : nil
    }

    func get(_ path: String) async throws -> ChannelDocument? {
        if Self.isLocalKind(path), let local = await router.active() {
            do { return try await local.backend.get(path) } catch { await router.operationFailed() }
        }
        return try await cloud.get(path)
    }

    func set(_ path: String, _ document: ChannelDocument) async throws {
        guard Self.isLocalKind(path) else { return try await cloud.set(path, document) }
        let id = Self.commandId(path)
        if let local = await router.active() {
            do {
                try await local.backend.set(path, document)
                if let id { await router.noteSent(id, via: .local) }
                return
            } catch let failure {
                await router.operationFailed()
                // A command exactly once: if the local write may have landed, take it back from the Mac first,
                // and send it through the cloud only when that is confirmed. Otherwise it could run twice.
                if id != nil, !LocalFailure.neverReached(failure) {
                    do { try await local.backend.delete(path) } catch { throw failure }
                }
            }
        }
        try await cloud.set(path, document)
        if let id { await router.noteSent(id, via: .cloud) }
    }

    func delete(_ path: String) async throws {
        guard Self.isLocalKind(path) else { return try await cloud.delete(path) }
        if let id = Self.commandId(path) {
            // Taking a command back must reach everywhere it may be: where it was sent, or both when unknown.
            switch await router.sentRoute(id) {
            case .local?:
                guard let local = await router.active() else { throw LocalFailure.notHTTP }
                try await local.backend.delete(path)
            case .cloud?:
                try await cloud.delete(path)
            case nil:
                if let local = await router.active() { try await local.backend.delete(path) }
                try await cloud.delete(path)
            }
            return
        }
        // A result the phone read: cleared where it was read; the Mac sweeps the rest.
        if let local = await router.active() {
            do { return try await local.backend.delete(path) } catch { await router.operationFailed() }
        }
        try await cloud.delete(path)
    }

    func changes(_ path: String) -> AsyncStream<Void>? {
        guard Self.isLocalKind(path) else { return cloud.changes(path) }
        return router.switching(cloud: cloud) { $0.changes(path) }
    }

    func documents(_ path: String) -> AsyncStream<DocumentChange>? {
        guard Self.isLocalKind(path) else { return cloud.documents(path) }
        return router.switching(cloud: cloud) { $0.documents(path) }
    }

    func events(in collection: String, documents names: [String]) -> AsyncStream<ChannelEvent>? {
        guard Self.isLocalKind(collection) else { return cloud.events(in: collection, documents: names) }
        return router.switching(cloud: cloud, make: { $0.events(in: collection, documents: names) }, isDrop: { $0 == .dropped })
    }

    func streamHealth() async -> [StreamHealth] {
        if let local = await router.active() { return await local.backend.streamHealth() }
        return await cloud.streamHealth()
    }
}

extension LocalRouter {
    /// A stream that follows the route: it reads the active backend's own stream, and when the route changes it
    /// moves to the other one. The new stream's first event says to re-read, so nothing is missed in between.
    /// A local stream that drops counts as a local failure, so the route falls back to the cloud.
    nonisolated func switching<T: Sendable>(
        cloud: ChannelBackend,
        make: @escaping @Sendable (ChannelBackend) -> AsyncStream<T>?,
        isDrop: @escaping @Sendable (T) -> Bool = { _ in false }
    ) -> AsyncStream<T> {
        AsyncStream { continuation in
            let outer = Task {
                var inner: Task<Void, Never>?
                for await active in await self.updates() {
                    inner?.cancel()
                    let onLocal = active.route == .local && active.backend != nil
                    guard let stream = make(onLocal ? active.backend! : cloud) else { continue }
                    inner = Task {
                        for await item in stream {
                            continuation.yield(item)
                            if onLocal, isDrop(item) { await self.operationFailed() }
                        }
                    }
                }
                inner?.cancel()
                continuation.finish()
            }
            continuation.onTermination = { _ in outer.cancel() }
        }
    }
}
