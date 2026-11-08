import Foundation

/// A message the person just sent to a working chat, shown in the queue at once while the daemon's own list
/// catches up. The daemon's reply route takes no client message id, so a pending item is matched to the polled
/// queue by text, among ids that were not there when it was sent (see `PendingQueue.reconcile`).
public struct PendingQueueItem: Sendable, Equatable, Identifiable {
    public enum State: Sendable, Equatable {
        /// The reply is in flight or accepted and the polled queue does not show it yet.
        case queuing
        /// Not sent (refused / not delivered): Retry or Edit.
        case failed(reason: String)
        /// The send's outcome is unknown: only Edit, never a retry.
        case unclear(reason: String)
    }

    public let id: String
    public let text: String
    public let sentAt: Date
    /// Queue ids already present when it was sent; a match must be a new id.
    public let baseline: Set<String>
    public var state: State
    /// True once the reply route answered "started"; only then may an unmatched item expire quietly.
    public var accepted: Bool

    public init(id: String = UUID().uuidString, text: String, sentAt: Date, baseline: Set<String>, state: State = .queuing, accepted: Bool = false) {
        self.id = id
        self.text = text
        self.sentAt = sentAt
        self.baseline = baseline
        self.state = state
        self.accepted = accepted
    }
}

/// One row of the queue stack: the daemon's message, or one still being queued.
public enum QueueRow: Sendable, Equatable, Identifiable {
    case queued(QueuedMessage)
    case pending(PendingQueueItem)

    public var id: String {
        switch self {
        case .queued(let m): m.id
        case .pending(let p): "pending-\(p.id)"
        }
    }
}

public enum PendingQueue {
    /// An accepted message the queue never shows (the turn ended and sent it, or it was steered) leaves after this.
    public static let expiry: TimeInterval = 20

    /// Whitespace-insensitive comparison; the daemon may trim.
    static func normalize(_ s: String) -> String {
        ImageAttachments.plainMentions(s).split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// Replaces each pending item that the polled queue now holds (same text, an id that was not there at send
    /// time, each polled message claimed once, oldest pending first), and drops an accepted one nothing matches
    /// after `expiry`. Failed and unclear items stay until the person acts. Returns what remains pending and the
    /// ids of polled messages that replaced one (so their Steer/Cancel are live at once).
    public static func reconcile(
        pending: [PendingQueueItem], polled: [QueuedMessage], now: Date
    ) -> (pending: [PendingQueueItem], matched: Set<String>) {
        var claimed = Set<String>()
        var remaining: [PendingQueueItem] = []
        for item in pending.sorted(by: { $0.sentAt < $1.sentAt }) {
            guard item.state == .queuing else { remaining.append(item); continue }
            let text = normalize(item.text)
            if let hit = polled.first(where: { !item.baseline.contains($0.id) && !claimed.contains($0.id) && normalize($0.text) == text }) {
                claimed.insert(hit.id)
                continue
            }
            if item.accepted, now.timeIntervalSince(item.sentAt) > expiry { continue }
            remaining.append(item)
        }
        return (remaining, claimed)
    }

    /// The rows to draw: the daemon's queue in its order, then what is still being queued.
    public static func rows(polled: [QueuedMessage], pending: [PendingQueueItem]) -> [QueueRow] {
        polled.map(QueueRow.queued) + pending.map(QueueRow.pending)
    }

    /// Seconds between queue reads: every second for the first 10 s after a send, then 2.5 s.
    public static func pollInterval(sinceSend: TimeInterval?) -> TimeInterval {
        guard let sinceSend, sinceSend >= 0, sinceSend < 10 else { return 2.5 }
        return 1
    }
}

/// What a send to a working chat does when nothing else is said (the daemon's `GET /control/send-default`),
/// and which of the two modes the composer's round button and ⌘↩ use.
public struct SendDefault: Sendable, Equatable {
    public var mode: SendMode
    public init(_ mode: SendMode) { self.mode = mode }

    /// What the round button and ⌘↩ do.
    public var primary: SendMode { mode }
    /// What the menu's other entry and ⇧⌘↩ do.
    public var other: SendMode { mode == .queue ? .steer : .queue }

    public static func title(_ mode: SendMode) -> String { mode == .queue ? "Queue" : "Steer" }

    public static func explanation(_ mode: SendMode) -> String {
        mode == .queue ? "after this turn" : "into the turn in progress"
    }

    /// The button's tooltip, e.g. "Queue: Claude reads it after this turn (⌘↩). Steer now: hold, or ⇧⌘↩".
    public func help(agent: String) -> String {
        let a = mode == .queue ? "Queue: \(agent) reads it after this turn" : "Steer: into the turn \(agent) is running now"
        let b = other == .queue ? "Queue: after this turn" : "Steer now"
        return "\(a) (⌘↩). \(b): hold, or ⇧⌘↩"
    }
}
