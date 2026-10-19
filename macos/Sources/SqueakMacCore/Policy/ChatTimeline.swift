import Foundation

/// What a chat shows, decided apart from the view so CI can test it: the transcript, your sends
/// (already merged in by the broker, "Sending…" until the transcript shows them), the session's
/// state and its live activity, in; the rows to draw, out.
///
/// The rules the owner asked for: a chat you just sent to, or that is working, never shows an empty
/// state; your message stays put; a "working" row sits under it with the live step ("Running
/// tests…", "Starting…" before the first); the previous agent message stays above, muted; a failed
/// send shows its refusal inline and no working row.
public enum ChatTimeline {
    public enum Row: Equatable, Identifiable, Sendable {
        case message(ChatMessage, muted: Bool)
        case working(label: String)
        /// A chat with genuinely nothing in it.
        case empty

        public var id: String {
            switch self {
            case .message(let m, _): m.id
            case .working: "working"
            case .empty: "empty"
            }
        }
    }

    /// A send that went out within this long and has had no reply yet still counts as "starting",
    /// even if the session has not said `working` yet.
    public static let startingWindow: TimeInterval = 180

    public static func rows(
        messages: [ChatMessage], state: SessionState, activity: [ActivityStep], now: Date = Date()
    ) -> [Row] {
        let working = isWorking(messages: messages, state: state, now: now)
        var muteIndex: Int?
        if working,
           let lastUser = messages.lastIndex(where: { $0.role == .user }),
           let lastAssistant = messages.lastIndex(where: { $0.role == .assistant }),
           lastAssistant < lastUser {
            muteIndex = lastAssistant
        }
        var rows: [Row] = messages.enumerated().map { .message($1, muted: $0 == muteIndex) }
        if working { rows.append(.working(label: workingLabel(activity))) }
        return rows.isEmpty ? [.empty] : rows
    }

    /// Working by the session's word, or by our own recent send that nothing has answered yet.
    public static func isWorking(messages: [ChatMessage], state: SessionState, now: Date = Date()) -> Bool {
        if state == .working { return true }
        guard state != .blocked, state != .error, let last = messages.last, last.role == .user else { return false }
        switch last.state {
        case .pending, .accepted, .uncertain, .confirmed:
            guard let at = last.at else { return last.state == .pending }
            return now.timeIntervalSince(at) < startingWindow
        default: return false // refused, not sent, a draft, or nothing: no working row
        }
    }

    /// "Running tests…", or "Starting…" before the first step arrives.
    public static func workingLabel(_ steps: [ActivityStep]) -> String {
        steps.isEmpty ? "Starting…" : ActivityPhrase.short(steps) + "…"
    }
}

public extension MessageState {
    /// The one short, muted line under a "You" bubble: sent, queued, steered or not sent. Nil for a
    /// draft or a message from the transcript that never went through us. `agent` names who reads a
    /// queued message ("Claude").
    func deliveryLine(agent: String) -> String? {
        switch self {
        case .draft: nil
        case .pending: "Sending…"
        case .accepted(_, let delivery, let note):
            switch delivery {
            case .queued:
                note == nil ? "Queued · \(agent) reads it after this turn"
                    : "Queued · \(agent) reads it after this turn (steering isn't available here)"
            case .steered: "Steered into the current turn"
            case .sent, nil: "Sent"
            }
        case .confirmed: "Sent"
        case .uncertain: "Not confirmed"
        case .refused(let reason), .notSent(let reason): "Not sent: \(reason)"
        }
    }

    /// Without an agent to name; kept for callers that have none.
    var deliveryLine: String? { deliveryLine(agent: "The agent") }
}

public extension ChatMessage {
    /// The delivery line for this message. A queued message reads "Queued" only while the agent is
    /// still on the turn it waited behind; once that turn is over the agent has read it, so it is
    /// simply "Sent". A steer stays "Steered": that is what happened.
    func deliveryLine(agent: String, agentWorking: Bool) -> String? {
        guard let state else { return nil }
        switch state {
        case .accepted(let via, let delivery, let note):
            let settled: Delivery? = delivery == .queued && !agentWorking ? .sent : delivery
            return MessageState.accepted(via: via, delivery: settled, note: note).deliveryLine(agent: agent)
        case .confirmed:
            let settled: Delivery? = delivery == .queued && !agentWorking ? .sent : delivery
            return MessageState.accepted(via: "", delivery: settled, note: deliveryNote).deliveryLine(agent: agent)
        default:
            return state.deliveryLine(agent: agent)
        }
    }
}
