import Foundation

/// Identity of a session on a host. Never merge sessions by title.
public struct SessionKey: Hashable, Codable, Sendable, CustomStringConvertible {
    public var provider: String
    public var installation: String
    public var workspaceId: String?
    public var hostSessionId: String

    public init(provider: String, installation: String = "local", workspaceId: String? = nil, hostSessionId: String) {
        self.provider = provider
        self.installation = installation
        self.workspaceId = workspaceId
        self.hostSessionId = hostSessionId
    }

    /// `provider:installation:workspaceId:hostSessionId` (workspace may be empty;
    /// the host id comes last because host ids can contain ':').
    public var stringValue: String {
        "\(provider):\(installation):\(workspaceId ?? ""):\(hostSessionId)"
    }

    public init?(stringValue: String) {
        let parts = stringValue.split(separator: ":", maxSplits: 3, omittingEmptySubsequences: false)
        guard parts.count == 4, !parts[0].isEmpty, !parts[3].isEmpty else { return nil }
        self.init(
            provider: String(parts[0]),
            installation: String(parts[1]),
            workspaceId: parts[2].isEmpty ? nil : String(parts[2]),
            hostSessionId: String(parts[3])
        )
    }

    public var description: String { stringValue }
}
