import Foundation

public enum MessageRole: String, Codable, Sendable, Hashable {
    case user, assistant
}

/// How a message meets an agent that is mid-turn: queue waits for the turn to end, steer goes into it.
public enum SendMode: String, Codable, Sendable, Hashable {
    case queue, steer
}

/// What the daemon reports happened to an accepted message. Nil on a message from a daemon that
/// predates queue and steer, which reads as plain "Sent".
public enum Delivery: String, Codable, Sendable, Hashable {
    case sent, queued, steered
}

/// draft -> pending -> accepted | uncertain | refused | notSent, and then
/// `confirmed` once the message is seen in the host transcript.
/// Nothing in this lifecycle ever re-sends.
public enum MessageState: Hashable, Codable, Sendable {
    case draft
    case pending
    /// `note` is set when what was asked for could not be done (steer fell back to queue).
    case accepted(via: String, delivery: Delivery? = nil, note: String? = nil)
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
    /// How the daemon said our send was delivered, kept once the transcript confirms it so the
    /// "Queued" / "Steered" line survives; nil on messages that never went through us.
    public var delivery: Delivery?
    public var deliveryNote: String?
    /// The row's position in the host's table (Conductor's rowid, as digits): paging for what precedes
    /// this message starts "before" it. Nil on messages we sent that the transcript has not shown, and on
    /// hosts that cannot page.
    public var cursor: String?

    public init(
        id: String, role: MessageRole, text: String, at: Date? = nil, turnId: String? = nil,
        clientId: UUID? = nil, state: MessageState? = nil, inReplyTo: UUID? = nil, cursor: String? = nil
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.at = at
        self.turnId = turnId
        self.clientId = clientId
        self.state = state
        self.inReplyTo = inReplyTo
        self.cursor = cursor
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
    case accepted(via: String, delivery: Delivery? = nil, note: String? = nil)
    case refused(reason: String)
    /// Timeout or connection drop after the request was written.
    case uncertain(reason: String)
    /// Failed before anything was written.
    case notSent(reason: String)

    public var messageState: MessageState {
        switch self {
        case .accepted(let via, let delivery, let note): .accepted(via: via, delivery: delivery, note: note)
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
