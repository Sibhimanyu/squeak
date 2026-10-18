import Foundation

/// What Settings › Connections says about each source, in plain words.
public struct ConnectionsReport: Equatable, Sendable {
    public enum Level: Sendable, Equatable { case ok, warning, problem, neutral }
    public struct Row: Equatable, Sendable {
        public var title: String
        public var value: String
        public var level: Level
        public var detail: String?
    }

    public var database: Row
    public var daemon: Row
    public var sending: Row

    /// - Parameters:
    ///   - databaseExists: `conductor.db` exists on disk.
    ///   - localHealth: health of `ConductorLocalAdapter` (nil when it is not in use).
    ///   - daemonHealth: health of the daemon adapter (nil before the first poll).
    public static func make(
        databaseExists: Bool, localHealth: AdapterHealth?, daemonHealth: AdapterHealth?, tokenPresent: Bool
    ) -> ConnectionsReport {
        let db: Row
        if !databaseExists {
            db = Row(title: "Conductor database", value: "Missing", level: .problem,
                     detail: "Conductor's database was not found, so chats come from the Squeak service instead.")
        } else if let h = localHealth {
            switch h.status {
            case .connected: db = Row(title: "Conductor database", value: "Readable", level: .ok, detail: "Read-only. Squeak never writes to it.")
            case .degraded(let r): db = Row(title: "Conductor database", value: "Not readable", level: .problem, detail: r)
            default: db = Row(title: "Conductor database", value: "Not readable", level: .problem, detail: nil)
            }
        } else {
            db = Row(title: "Conductor database", value: "Checking", level: .neutral, detail: nil)
        }

        let daemon: Row
        if let h = daemonHealth {
            switch h.status {
            case .daemonDown:
                daemon = Row(title: "Squeak service", value: "Down", level: .problem, detail: "Not answering on this Mac.")
            case .tokenMissing:
                daemon = Row(title: "Squeak service", value: "Token missing", level: .warning,
                             detail: "Running, but its access token file was not found.")
            case .degraded(let r):
                daemon = Row(title: "Squeak service", value: "Trouble", level: .warning, detail: r)
            case .connected:
                daemon = tokenPresent
                    ? Row(title: "Squeak service", value: "Connected", level: .ok, detail: nil)
                    : Row(title: "Squeak service", value: "Token missing", level: .warning, detail: "Running, but its access token file was not found.")
            }
        } else {
            daemon = Row(title: "Squeak service", value: "Checking", level: .neutral, detail: nil)
        }

        let sending: Row
        if daemonHealth?.status == .connected, tokenPresent {
            sending = Row(title: "Sending", value: "Available via Squeak service", level: .ok,
                          detail: "Replies are typed into the chat in Conductor by the service.")
        } else if daemonHealth == nil {
            sending = Row(title: "Sending", value: "Checking", level: .neutral, detail: nil)
        } else if daemonHealth?.status == .daemonDown {
            sending = Row(title: "Sending", value: "Unavailable", level: .problem, detail: "The Squeak service is down.")
        } else if !tokenPresent || daemonHealth?.status == .tokenMissing {
            sending = Row(title: "Sending", value: "Unavailable", level: .problem, detail: "Squeak's access token was not found.")
        } else {
            sending = Row(title: "Sending", value: "Unavailable", level: .problem, detail: "The Squeak service is having trouble.")
        }
        return ConnectionsReport(database: db, daemon: daemon, sending: sending)
    }
}
