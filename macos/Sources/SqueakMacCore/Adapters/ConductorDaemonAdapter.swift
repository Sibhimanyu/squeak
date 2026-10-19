import CryptoKit
import Foundation

/// Step 1 adapter: Conductor (and every other agent the daemon sees), through the daemon.
public struct ConductorDaemonAdapter: HostAdapter {
    public let id = "conductor-daemon"
    private let client: DaemonClient
    private let now: @Sendable () -> Date
    private let includeConductor: Bool

    /// - Parameter includeConductor: false when `ConductorLocalAdapter` owns Conductor's
    ///   chats; the daemon's Conductor rows are then dropped so no chat appears twice
    ///   and no Conductor key comes from here.
    public init(client: DaemonClient, includeConductor: Bool = true, now: @escaping @Sendable () -> Date = { Date() }) {
        self.client = client
        self.includeConductor = includeConductor
        self.now = now
    }

    // MARK: Mapping

    /// `conductor` for Conductor's own chats; otherwise `<agent>-<origin>` (claude-terminal,
    /// codex-terminal, claude-desktop, claude-sdk ...).
    static func provider(origin: String?, agent: String?) -> String {
        let o = (origin?.isEmpty == false) ? origin! : "unknown"
        if o == "conductor" { return "conductor" }
        let a = (agent?.isEmpty == false) ? agent! : "agent"
        return "\(a)-\(o)"
    }

    static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s
    }

    static func map(_ d: DaemonSession) -> HostSession {
        let provider = provider(origin: d.origin, agent: d.agent)
        let workspace = nonEmpty(d.conductorWorkspaceId)
        let conductorSession = nonEmpty(d.conductorSessionId) ?? (provider == "conductor" ? nonEmpty(d.replyTarget) : nil)
        let replyTarget = nonEmpty(d.replyTarget)
        var caps = Capabilities(
            discover: .supported,
            readTranscript: .supported,
            send: replyTarget == nil ? .unsupported("Squeak has no way to reply to this session") : .supported,
            activity: .supported,
            approve: .unsupported("Approve in the host app"),
            openInHost: .unsupported("This session cannot be opened from Squeak"),
            attachments: .unsupported("Attachments are not supported yet")
        )
        if provider == "conductor", workspace != nil, conductorSession != nil { caps.openInHost = .supported }
        return HostSession(
            key: SessionKey(provider: provider, workspaceId: workspace, hostSessionId: d.key),
            title: d.title ?? "",
            distinctTitle: nonEmpty(d.distinctTitle),
            repoName: nonEmpty(d.repoName),
            branch: nonEmpty(d.branch),
            cwd: nonEmpty(d.cwd),
            agent: nonEmpty(d.agent),
            state: SessionState(daemon: d.state),
            lastActivityAt: d.lastActivityAt,
            alive: d.alive,
            replyTarget: replyTarget,
            conductorWorkspaceId: workspace,
            conductorSessionId: conductorSession,
            capabilities: caps,
            origin: .hostOwned,
            awaitingApproval: d.state == "awaiting_approval" ? true : nil
        )
    }

    // MARK: HostAdapter

    public func discover() async throws -> [HostSession] {
        let all = try await client.state().sessions.map(Self.map)
        return includeConductor ? all : all.filter { $0.key.provider != "conductor" }
    }

    public func transcript(for session: HostSession, limit: Int) async throws -> [ChatMessage] {
        guard let target = session.replyTarget else { return [] }
        if let t = try await client.transcript(replyTarget: target, limit: limit) {
            return t.messages.compactMap { m in
                guard let role = MessageRole(rawValue: m.role) else { return nil }
                return ChatMessage(id: m.id, role: role, text: m.text, at: m.at, turnId: m.turnId)
            }
        }
        // Older daemon: only the last assistant turn is available.
        guard let last = try await client.lastMessage(replyTarget: target), !last.text.isEmpty else { return [] }
        let digest = SHA256.hash(data: Data(last.text.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
        return [ChatMessage(id: "last-\(digest)", role: .assistant, text: last.text, at: nil, turnId: nil)]
    }

    public func activity(for session: HostSession) async throws -> [ActivityStep] {
        try await client.activity(sessionKey: session.key.hostSessionId).steps.map {
            ActivityStep(kind: $0.kind, text: $0.text, at: $0.at)
        }
    }

    public func send(_ text: String, to session: HostSession, clientId: UUID) async -> SendResult {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .notSent(reason: "Nothing to send") }
        guard let target = session.replyTarget else { return .notSent(reason: "Squeak has no way to reply to this session") }
        return await client.reply(replyTarget: target, text: text)
    }

    public func openInHostURL(for session: HostSession) -> URL? {
        guard session.key.provider == "conductor",
              let ws = session.conductorWorkspaceId, let sid = session.conductorSessionId else { return nil }
        var c = URLComponents()
        c.scheme = "conductor"
        c.host = "workspace"
        c.queryItems = [URLQueryItem(name: "id", value: ws), URLQueryItem(name: "session", value: sid)]
        return c.url
    }

    public func health() async -> AdapterHealth {
        do {
            _ = try await client.state()
            return AdapterHealth(adapterId: id, status: client.hasToken ? .connected : .tokenMissing)
        } catch AdapterError.daemonDown {
            return AdapterHealth(adapterId: id, status: .daemonDown)
        } catch {
            return AdapterHealth(adapterId: id, status: .degraded("\(error)"))
        }
    }
}
