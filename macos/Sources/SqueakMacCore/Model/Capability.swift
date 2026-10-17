import Foundation

public enum Capability: Hashable, Codable, Sendable {
    case supported
    case unsupported(String)
    case unknown

    public var isSupported: Bool { self == .supported }

    /// Why the action is unavailable, for the UI to show.
    public var reason: String? {
        if case .unsupported(let r) = self { return r }
        return nil
    }
}

public enum CapabilityAction: String, CaseIterable, Codable, Sendable {
    case discover, readTranscript, send, activity, approve, openInHost, attachments
}

public struct Capabilities: Hashable, Codable, Sendable {
    public var discover: Capability
    public var readTranscript: Capability
    public var send: Capability
    public var activity: Capability
    public var approve: Capability
    public var openInHost: Capability
    public var attachments: Capability

    public init(
        discover: Capability = .unknown, readTranscript: Capability = .unknown,
        send: Capability = .unknown, activity: Capability = .unknown,
        approve: Capability = .unknown, openInHost: Capability = .unknown,
        attachments: Capability = .unknown
    ) {
        self.discover = discover
        self.readTranscript = readTranscript
        self.send = send
        self.activity = activity
        self.approve = approve
        self.openInHost = openInHost
        self.attachments = attachments
    }

    public subscript(action: CapabilityAction) -> Capability {
        switch action {
        case .discover: discover
        case .readTranscript: readTranscript
        case .send: send
        case .activity: activity
        case .approve: approve
        case .openInHost: openInHost
        case .attachments: attachments
        }
    }
}
