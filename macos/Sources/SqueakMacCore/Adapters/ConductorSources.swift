import Foundation

/// Decides which adapters serve which sessions.
public enum ConductorSources {
    /// Normal case: `ConductorLocalAdapter` (reads Conductor's database, sends
    /// through the daemon) owns every Conductor chat; the daemon adapter serves
    /// only non-Conductor sessions. If `conductor.db` is missing, the daemon
    /// adapter serves Conductor chats too, as before.
    public static func adapters(
        client: DaemonClient,
        database: ConductorDatabase = ConductorDatabase(),
        activityReader: ClaudeActivityReader = ClaudeActivityReader(),
        native: NativeHostClient? = nil
    ) -> [any HostAdapter] {
        // Squeak's own chats come first, so their keys are owned by the adapter that has the transcript, the
        // diffs and the controls; the daemon adapter's row for the same chat is then a duplicate the broker drops.
        let own: [any HostAdapter] = native.map { [NativeAdapter(host: $0, daemon: client)] } ?? []
        guard database.exists else {
            return own + [ConductorDaemonAdapter(client: client)]
        }
        return own + [
            ConductorLocalAdapter(
                database: database, activityReader: activityReader, sender: DaemonSender(client: client),
                askSource: { await daemonAsks(client) }),
            ConductorDaemonAdapter(client: client, includeConductor: false),
        ]
    }

    /// The daemon's view of each Conductor chat's closing question, by chat id; nil when it is not reachable.
    static func daemonAsks(_ client: DaemonClient) async -> [String: DaemonAskView]? {
        guard let state = try? await client.state() else { return nil }
        var out: [String: DaemonAskView] = [:]
        for d in state.sessions {
            guard let id = d.conductorSessionId, !id.isEmpty else { continue }
            out[id] = DaemonAskView(state: d.state, lastActivityAt: d.lastActivityAt, asks: d.asks)
        }
        return out
    }
}
