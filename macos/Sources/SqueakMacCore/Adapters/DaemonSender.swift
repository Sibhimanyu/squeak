import Foundation

/// Sends into a Conductor chat through the Squeak daemon's existing
/// `POST /control/session/<conductorSessionId>/reply`, the same route the
/// window and Telegram use. The daemon types into Conductor's own window (or
/// refuses, with a reason Squeak shows as is). Outcome mapping is `DaemonClient.reply`'s.
///
/// Readiness is a cached health check (daemon answers `/state` and the token
/// file exists), refreshed by the adapter on every broker poll.
public final class DaemonSender: ConductorSender, @unchecked Sendable {
    private let client: DaemonClient
    private let now: @Sendable () -> Date
    private let minRecheck: TimeInterval
    private let lock = NSLock()
    private var reachable = false
    private var checkedAt: Date?

    public init(client: DaemonClient, minRecheck: TimeInterval = 2, now: @escaping @Sendable () -> Date = { Date() }) {
        self.client = client
        self.minRecheck = minRecheck
        self.now = now
    }

    public var isReady: Bool { lock.withLock { reachable } && client.hasToken }

    public var unavailableReason: String {
        if !lock.withLock({ reachable }) { return "The Squeak service isn't running, so replies can't be delivered" }
        if !client.hasToken { return "Squeak's access token was not found" }
        return "Sending is not available"
    }

    public var unavailableIsTransient: Bool { !lock.withLock { reachable } }

    public func refresh() async {
        let due = lock.withLock { checkedAt.map { now().timeIntervalSince($0) >= minRecheck } ?? true }
        guard due else { return }
        await probe()
    }

    public func recheck() async { await probe() }

    private func probe() async {
        let ok = (try? await client.state()) != nil
        lock.withLock {
            reachable = ok
            checkedAt = now()
        }
    }

    public func send(workspaceId: String, sessionId: String, text: String) async -> SendResult {
        await client.reply(replyTarget: sessionId, text: text)
    }

    public func send(workspaceId: String, sessionId: String, text: String, mode: SendMode) async -> SendResult {
        await client.reply(replyTarget: sessionId, text: text, mode: mode)
    }
}
