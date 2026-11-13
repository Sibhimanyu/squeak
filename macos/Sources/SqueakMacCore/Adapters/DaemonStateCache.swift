import Foundation

/// `/state` is 50+ KB and wanted by several readers (the broker's two adapters, usage, awake). This keeps the last
/// answer and its ETag so an unchanged state costs a 304 and no decode, shares one read among readers that ask at
/// once or within `window`, and hands back the same decoded value while the body is byte-identical. An older daemon
/// sends no ETag and gets plain reads, only de-duplicated.
final class DaemonStateCache: @unchecked Sendable {
    private let window: TimeInterval
    private let now: @Sendable () -> Date
    private let lock = NSLock()
    private var etag: String?
    private var body: Data?
    private var value: DaemonState?
    private var fetchedAt: Date?
    private var inflight: Task<DaemonState, Error>?
    /// Reads that went to the daemon, answers that were a 304 or an identical body (tests read these).
    private(set) var requests = 0
    private(set) var notModified = 0
    private(set) var decodes = 0

    init(window: TimeInterval, now: @escaping @Sendable () -> Date) {
        self.window = window
        self.now = now
    }

    func read(
        fetch: @escaping @Sendable (_ etag: String?) async throws -> HTTPResponse,
        decode: @escaping @Sendable (Data) throws -> DaemonState
    ) async throws -> DaemonState {
        let task: Task<DaemonState, Error> = lock.withLock {
            if let value, let fetchedAt, window > 0, now().timeIntervalSince(fetchedAt) < window {
                return Task { value }
            }
            if let inflight { return inflight }
            let sent = self.etag
            let t = Task { [self] in
                defer { lock.withLock { inflight = nil } }
                lock.withLock { requests += 1 }
                let r = try await fetch(sent)
                if let same = try unchanged(r) { return same }
                let decoded = try decode(r.body)
                lock.withLock {
                    decodes += 1
                    body = r.body
                    value = decoded
                    etag = r.headers["etag"]
                    fetchedAt = now()
                }
                return decoded
            }
            inflight = t
            return t
        }
        return try await task.value
    }

    /// The held value when the answer says nothing changed (304, or the same bytes); throws on any other failure.
    private func unchanged(_ r: HTTPResponse) throws -> DaemonState? {
        try lock.withLock {
            if r.status == 304, let value { fetchedAt = now(); notModified += 1; return value }
            guard r.status == 200 else { throw AdapterError.http(r.status) }
            if let value, body == r.body { fetchedAt = now(); notModified += 1; return value }
            return nil
        }
    }
}
