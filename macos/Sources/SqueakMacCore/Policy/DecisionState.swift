import Foundation

/// What a question card in the conversation may do, decided apart from the view so CI can test it.
public enum DecisionPhase: Equatable, Sendable {
    /// The card's question is the session's pending one: its controls work.
    case live
    /// This Mac delivered the answer: the card shows its result line.
    case answeredHere
    /// The question is no longer pending and this Mac did not answer it (Conductor, the phone, a typed reply):
    /// the card stays, disabled, and says so.
    case answeredElsewhere

    public static func resolve(cardToolUseId: String, pendingToolUseId: String?, answeredHereToolUseId: String?) -> DecisionPhase {
        if let answeredHereToolUseId, answeredHereToolUseId == cardToolUseId { return .answeredHere }
        if let pendingToolUseId, pendingToolUseId == cardToolUseId { return .live }
        return .answeredElsewhere
    }

    public static let elsewhereLine = "Answered elsewhere"
}

/// The composer is the second way to answer while a decision waits: it folds to one quiet button so the
/// card holds the only prominent Send. It opens on a press, and stays open for a draft already written.
public enum ComposerFold {
    public static let foldedTitle = "Write a different message instead"

    public static func isFolded(decisionPending: Bool, expanded: Bool, hasDraft: Bool) -> Bool {
        decisionPending && !expanded && !hasDraft
    }
}

/// A tool-permission block: the chat is blocked and the daemon said approval, not input, and no question
/// card or lettered options explain the block. Squeak never approves a tool; it points at Conductor.
public enum ApprovalWait {
    public static let line = "Waiting for your approval in Conductor."

    public static func isWaiting(state: SessionState, awaitingApproval: Bool?, hasQuestionCard: Bool) -> Bool {
        state == .blocked && awaitingApproval == true && !hasQuestionCard
    }
}
