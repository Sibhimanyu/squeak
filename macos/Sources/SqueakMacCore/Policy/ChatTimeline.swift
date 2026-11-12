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
        // A progress update is the tracker's, not a step of the turn.
        let steps = steps.filter { $0.kind != "progress" }
        // The live retry line is the label while it is the newest step; the next step clears it (the transcript drops it).
        if let last = steps.last, last.kind == "retry" { return last.text }
        let calm = steps.filter { $0.kind != "retry" }
        return calm.isEmpty ? "Starting…" : ActivityPhrase.short(calm) + "…"
    }
}

public extension ChatMessage {
    /// Why a send did not go, for the failed bubble's tooltip and VoiceOver. The bubble itself says it visually
    /// (a danger outline and Retry); no line of words sits under any message.
    var failureReason: String? {
        switch state {
        case .refused(let reason), .notSent(let reason): reason
        default: nil
        }
    }
}
