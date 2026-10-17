import Foundation

public enum MessageRole: String, Codable, Sendable, Hashable {
    case user, assistant
}

/// draft -> pending -> accepted | uncertain | refused | notSent, and then
/// `confirmed` once the message is seen in the host transcript.
/// Nothing in this lifecycle ever re-sends.
public enum MessageState: Hashable, Codable, Sendable {
    case draft
    case pending
    case accepted(via: String)
    case uncertain(reason: String)
    case refused(reason: String)
    case notSent(reason: String)
    case confirmed
}

public struct ChatMessage: Hashable, Codable, Sendable, Identifiable {
    /// Host id for transcript messages; `local-<clientId>` for messages we sent
    /// that the transcript has not shown yet.
    public var id: String
    public var role: MessageRole
    public var text: String
    public var at: Date?
    public var turnId: String?
    /// Set on messages we sent (and on the host copy once confirmed).
    public var clientId: UUID?
    public var state: MessageState?
    /// An assistant message that followed a confirmed send of ours.
    public var inReplyTo: UUID?

    public init(
        id: String, role: MessageRole, text: String, at: Date? = nil, turnId: String? = nil,
        clientId: UUID? = nil, state: MessageState? = nil, inReplyTo: UUID? = nil
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.at = at
        self.turnId = turnId
        self.clientId = clientId
        self.state = state
        self.inReplyTo = inReplyTo
    }
}

public struct ActivityStep: Hashable, Codable, Sendable {
    public var kind: String
    public var text: String
    public var at: Date?

    public init(kind: String, text: String, at: Date? = nil) {
        self.kind = kind
        self.text = text
        self.at = at
    }
}

public enum SendResult: Hashable, Sendable {
    case accepted(via: String)
    case refused(reason: String)
    /// Timeout or connection drop after the request was written.
    case uncertain(reason: String)
    /// Failed before anything was written.
    case notSent(reason: String)

    public var messageState: MessageState {
        switch self {
        case .accepted(let via): .accepted(via: via)
        case .refused(let r): .refused(reason: r)
        case .uncertain(let r): .uncertain(reason: r)
        case .notSent(let r): .notSent(reason: r)
        }
    }
}

public enum ConnectionStatus: Hashable, Sendable {
    case connected
    case daemonDown
    case tokenMissing
    case degraded(String)
}

public struct AdapterHealth: Hashable, Sendable {
    public var adapterId: String
    public var status: ConnectionStatus
    public var lastSyncedAt: Date?

    public init(adapterId: String, status: ConnectionStatus, lastSyncedAt: Date? = nil) {
        self.adapterId = adapterId
        self.status = status
        self.lastSyncedAt = lastSyncedAt
    }
}

public enum AdapterError: Error, Equatable, Sendable {
    case daemonDown
    case tokenMissing
    case tokenRejected
    case http(Int)
    case badResponse(String)
    case timedOut
}
