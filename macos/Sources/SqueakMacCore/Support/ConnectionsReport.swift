import Foundation

/// What Settings › Connections says about each source, in plain words.
public struct ConnectionsReport: Equatable, Sendable {
    public enum Level: Sendable, Equatable { case ok, warning, problem, neutral }
    public struct Row: Equatable, Sendable {
        public var title: String
        public var value: String
        public var level: Level
        public var detail: String?
        public init(title: String, value: String, level: Level, detail: String? = nil) {
            self.title = title; self.value = value; self.level = level; self.detail = detail
        }
    }

    /// Rows enabled add-ons contribute (a host app's database, say), above the service's.
    public var addonRows: [Row]
    public var daemon: Row
    public var sending: Row

    /// - Parameters:
    ///   - addonRows: what each enabled add-on says about its own source.
    ///   - daemonHealth: health of the daemon adapter (nil before the first poll).
    public static func make(addonRows: [Row] = [], daemonHealth: AdapterHealth?, tokenPresent: Bool) -> ConnectionsReport {
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
                          detail: "Replies are sent by the service: typed into the chat's own app, or the agent's terminal.")
        } else if daemonHealth == nil {
            sending = Row(title: "Sending", value: "Checking", level: .neutral, detail: nil)
        } else if daemonHealth?.status == .daemonDown {
            sending = Row(title: "Sending", value: "Unavailable", level: .problem, detail: "The Squeak service is down.")
        } else if !tokenPresent || daemonHealth?.status == .tokenMissing {
            sending = Row(title: "Sending", value: "Unavailable", level: .problem, detail: "Squeak's access token was not found.")
        } else {
            sending = Row(title: "Sending", value: "Unavailable", level: .problem, detail: "The Squeak service is having trouble.")
        }
        return ConnectionsReport(addonRows: addonRows, daemon: daemon, sending: sending)
    }
}
