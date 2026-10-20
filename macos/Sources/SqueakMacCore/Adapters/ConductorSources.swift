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
        activityReader: ClaudeActivityReader = ClaudeActivityReader()
    ) -> [any HostAdapter] {
        guard database.exists else {
            return [ConductorDaemonAdapter(client: client)]
        }
        return [
            ConductorLocalAdapter(database: database, activityReader: activityReader, sender: DaemonSender(client: client)),
            ConductorDaemonAdapter(client: client, includeConductor: false),
        ]
    }
}
