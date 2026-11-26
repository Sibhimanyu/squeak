import Foundation

// Add, remove, leave and delete are done only when the cloud confirms (docs/spec.md, People and remote, "Live and honest").
// The host answers an action after the cloud took it, so "done" is drawn from its answer and never before: until then the
// thing says Inviting…, Removing…, Leaving… or Deleting… in place, and a failure stays where it was with one
// sentence and Try again. Nothing here ever shows a result that was not confirmed.

public enum PondActionKind: String, Sendable, Equatable {
    case invite, resend, withdraw, remove, leave, delete
}

extension PondActionWords {
    /// The word in place while the cloud has not answered.
    public static func pending(_ kind: PondActionKind, who: String?) -> String {
        switch kind {
        case .invite: "Inviting\u{2026}"
        case .resend: "Resending\u{2026}"
        case .withdraw: "Withdrawing\u{2026}"
        case .remove: who.map { "Removing \($0)\u{2026}" } ?? "Removing\u{2026}"
        case .leave: "Leaving\u{2026}"
        case .delete: "Deleting\u{2026}"
        }
    }

    /// The line after the cloud confirmed; only ever asked for from a confirmation.
    public static func done(_ kind: PondActionKind, who: String?) -> String {
        switch kind {
        case .invite: "Invited."
        case .resend: "Sent again."
        case .withdraw: "Withdrawn."
        case .remove: "\(who ?? "They") was removed."
        case .leave: "You left."
        case .delete: "Deleted."
        }
    }

    public static let tryAgain = "Try again"

    /// One sentence for a failure: the host's reason when it gave one, else the plain default. Always ends in a full stop.
    public static func failure(_ kind: PondActionKind, who: String?, reason: String?) -> String {
        let what: String = switch kind {
        case .invite: "invite"
        case .resend: "resend the invite"
        case .withdraw: "withdraw the invite"
        case .remove: "remove \(who ?? "them")"
        case .leave: "leave the Pond"
        case .delete: "delete the Pond"
        }
        let why = reason?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmptyString
        guard let why else { return "Squeak couldn\u{2019}t \(what). The cloud didn\u{2019}t confirm it." }
        return "Squeak couldn\u{2019}t \(what): \(why.hasSuffix(".") ? String(why.dropLast()) : why)."
    }
}

private extension String { var nilIfEmptyString: String? { isEmpty ? nil : self } }

/// What is true of each action right now, by its key (`remove:<pond>:<member>`, `leave:<pond>`, ...).
public struct PondActionTracker: Sendable, Equatable {
    public enum State: Sendable, Equatable {
        case pending(kind: PondActionKind, who: String?)
        case failed(kind: PondActionKind, who: String?, sentence: String)
        case done(line: String)
    }

    public private(set) var states: [String: State] = [:]
    public init() {}

    /// The press (or Try again): pending in place, whatever it was before.
    public mutating func begin(_ key: String, _ kind: PondActionKind, who: String? = nil) {
        states[key] = .pending(kind: kind, who: who)
    }

    /// The cloud confirmed: only now is there a done line.
    public mutating func confirm(_ key: String) {
        guard case .pending(let kind, let who)? = states[key] else { return }
        states[key] = .done(line: PondActionWords.done(kind, who: who))
    }

    /// The cloud did not confirm: stays, with its one sentence.
    public mutating func fail(_ key: String, reason: String?) {
        guard case .pending(let kind, let who)? = states[key] else { return }
        states[key] = .failed(kind: kind, who: who, sentence: PondActionWords.failure(kind, who: who, reason: reason))
    }

    public mutating func clear(_ key: String) { states[key] = nil }

    public func isPending(_ key: String) -> Bool { if case .pending? = states[key] { true } else { false } }

    /// What to draw in place: "Removing…" while pending, the sentence on failure, the done line after confirmation.
    public func line(_ key: String) -> String? {
        switch states[key] {
        case .pending(let kind, let who)?: PondActionWords.pending(kind, who: who)
        case .failed(_, _, let sentence)?: sentence
        case .done(let line)?: line
        case nil: nil
        }
    }

    /// Failed actions offer Try again and nothing else does.
    public func offersTryAgain(_ key: String) -> Bool { if case .failed? = states[key] { true } else { false } }

    /// A failed action's own sentence, for drawing it in the failure colour.
    public func failure(_ key: String) -> String? { if case .failed(_, _, let s)? = states[key] { s } else { nil } }
}
