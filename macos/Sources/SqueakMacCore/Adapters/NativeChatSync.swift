import Foundation

/// Keeps an open native chat honest when its event stream goes quiet or dies (a host restart, a half-open socket).
/// Pure decisions, so the clock is a parameter and tests need no sleeping.
///
/// - After a send, silence for `postSendSilence` (3 s) forces a reconnect and a refetch (once per send).
/// - While the chat is working or a send is recent, the host's status/seq is compared every `pollEvery` (10 s).
public struct NativeSyncWatchdog: Equatable, Sendable {
    public enum Action: Equatable, Sendable { case none, reconnect, poll }

    public static let postSendSilence: TimeInterval = 3
    public static let pollEvery: TimeInterval = 10
    /// After a send, until the turn's first agent row arrives, the host is asked this often (a cold runner can take
    /// 10+ s before it says anything; the stream alone is not trusted for that stretch).
    public static let fastPollEvery: TimeInterval = 3
    /// How long after a send the chat counts as "just sent" for the safety poll.
    public static let recentSend: TimeInterval = 120

    private var lastEvent: Date?
    private var sentAt: Date?
    private var reconnectedForSend = false
    private var lastPoll: Date?
    public private(set) var status: String?
    /// A send is out and the turn's first agent row has not arrived: poll fast.
    public private(set) var awaitingAgentRow = false

    public init() {}

    /// The agent's first row of the turn reached the Mac: from here the stream is relied on.
    public mutating func noteAgentRow() { awaitingAgentRow = false }

    public mutating func noteEvent(at now: Date) {
        lastEvent = now
    }

    public mutating func noteStatus(_ s: String?) { status = s }

    public mutating func noteSend(at now: Date) {
        sentAt = now
        awaitingAgentRow = true
        reconnectedForSend = false
        lastPoll = now
    }

    /// The stream was re-opened by us: silence is measured from now.
    public mutating func noteReconnect(at now: Date) {
        lastEvent = now
        lastPoll = now
    }

    public mutating func tick(at now: Date) -> Action {
        if let sent = sentAt, !reconnectedForSend, now.timeIntervalSince(sent) >= Self.postSendSilence,
           (lastEvent ?? .distantPast) <= sent {
            reconnectedForSend = true
            lastPoll = now
            return .reconnect
        }
        let recent = sentAt.map { now.timeIntervalSince($0) < Self.recentSend } ?? false
        let every = awaitingAgentRow && recent ? Self.fastPollEvery : Self.pollEvery
        if status == "working" || status.map(NativeStatus.isStopping) == true || recent, now.timeIntervalSince(lastPoll ?? .distantPast) >= every {
            lastPoll = now
            return .poll
        }
        return .none
    }

    /// The poll's verdict: does what the host says differ from what the Mac holds?
    public static func mismatch(hostStatus: String, hostLastSeq: Int, status: String?, lastSeq: Int) -> Bool {
        hostStatus != status || hostLastSeq > lastSeq
    }
}

/// Seq-keyed merge so a refetch after a reconnect never shows a message twice.
public enum NativeSeqMerge {
    public static func merge(_ existing: [NativeMessage], with fetched: [NativeMessage]) -> [NativeMessage] {
        var bySeq: [Int: NativeMessage] = [:]
        for m in existing { bySeq[m.seq] = m }
        for m in fetched { bySeq[m.seq] = m }
        return bySeq.values.sorted { $0.seq < $1.seq }
    }
}

/// When a stream last delivered a line (a lock: the forwarder and the watchdog are sibling tasks).
final class StreamActivity: @unchecked Sendable {
    private let lock = NSLock()
    private var last = ContinuousClock.now
    func touch() { lock.lock(); last = .now; lock.unlock() }
    func idle(for d: Duration) -> Bool { lock.lock(); defer { lock.unlock() }; return ContinuousClock.now - last >= d }
}

extension NativeHostClient {
    /// Wraps a line source so a connection that delivers nothing (heartbeats included) for `idleTimeout` ends with an
    /// error, however open it looks; the stream then reconnects.
    static func withIdleTimeout(
        _ source: @escaping @Sendable (HTTPRequest) -> AsyncThrowingStream<String, Error>, _ idleTimeout: Duration
    ) -> @Sendable (HTTPRequest) -> AsyncThrowingStream<String, Error> {
        { request in
            AsyncThrowingStream { continuation in
                let activity = StreamActivity()
                let reader = Task {
                    do {
                        for try await line in source(request) { activity.touch(); continuation.yield(line) }
                        continuation.finish()
                    } catch { continuation.finish(throwing: error) }
                }
                let watchdog = Task {
                    let step = max(idleTimeout / 4, .milliseconds(5))
                    while !Task.isCancelled {
                        try? await Task.sleep(for: step)
                        if activity.idle(for: idleTimeout) { continuation.finish(throwing: NativeHostError.badResponse); reader.cancel(); return }
                    }
                }
                continuation.onTermination = { _ in reader.cancel(); watchdog.cancel() }
            }
        }
    }
}
