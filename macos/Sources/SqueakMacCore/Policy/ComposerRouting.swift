import Foundation

/// Who the quick composer addresses when it opens, and what it remembers of unsent text.
public enum ComposerRouting {
    /// An explicit target (a clicked notification) always wins, even if it can no longer be sent
    /// to: the composer then disables Send rather than quietly aiming at another chat. Without
    /// one, the last chat messaged, then the first chat that needs you.
    public static func target(
        explicit: SessionKey?, lastUsed: SessionKey?, needsYou: [SessionKey], canSend: (SessionKey) -> Bool
    ) -> SessionKey? {
        if let explicit { return explicit }
        if let lastUsed, canSend(lastUsed) { return lastUsed }
        return needsYou.first(where: canSend)
    }
}

/// Unsent composer text, kept per chat so a dismissal loses nothing and a draft can never
/// follow the user into a different chat.
public struct ComposerDrafts: Sendable, Equatable {
    private var byTarget: [SessionKey: String] = [:]
    /// Text typed before any chat was chosen. It belongs to no chat until the user picks one.
    private var unassigned = ""

    public init() {}

    public func text(for key: SessionKey?) -> String {
        guard let key else { return unassigned }
        return byTarget[key] ?? ""
    }

    /// Whitespace-only text is not a draft. With no chat, it goes to the unassigned slot.
    public mutating func stash(_ text: String, for key: SessionKey?) {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : text
        guard let key else { unassigned = value ?? ""; return }
        byTarget[key] = value
    }

    /// The destination menu picked `new` while `current` was on screen for `old`; returns what the
    /// field should now show. A chat's draft stays with that chat. Text typed before any chat was
    /// chosen goes to the first one picked, after that chat's own draft if it has one: nothing is lost.
    public mutating func choose(_ new: SessionKey, from old: SessionKey?, current: String) -> String {
        if old == new { return current }
        guard old == nil else {
            stash(current, for: old)
            return text(for: new)
        }
        func blank(_ s: String) -> Bool { s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        let carried = blank(current) ? unassigned : current
        unassigned = ""
        let own = byTarget[new] ?? ""
        byTarget[new] = nil
        if blank(carried) { return own }
        return blank(own) ? carried : own + "\n\n" + carried
    }

    /// What a finished send changes in a composer that may have been hidden, reopened or retargeted
    /// since it started. Only the same show takes the outcome; the same chat showing the very text
    /// that was sent is also cleared on success (so it cannot be sent twice) and told of a failure.
    public struct Settlement: Sendable, Equatable {
        public var clearText: Bool
        public var adoptResult: Bool
    }

    public static func settlement(
        sent: String, to key: SessionKey, startedEpoch: Int, currentEpoch: Int,
        target: SessionKey?, text: String, accepted: Bool
    ) -> Settlement {
        let sameShow = startedEpoch == currentEpoch
        let sameDraft = target == key && text == sent
        return Settlement(clearText: accepted && sameDraft, adoptResult: sameShow || (!accepted && sameDraft))
    }

    /// Forgets a draft once it was sent, unless the user has since typed something else.
    public mutating func sent(_ text: String, to key: SessionKey) {
        if byTarget[key] == text { byTarget[key] = nil }
    }
}

public enum NotificationRouting {
    /// The chat a notification response opens the composer for. A dismissal opens nothing, and a
    /// missing or malformed session id opens nothing. Typed text from an old inline Reply action
    /// is never read, so a notification delivered by an older version cannot send anything.
    public static func sessionToOpen(dismissed: Bool, session: String?) -> SessionKey? {
        guard !dismissed, let session else { return nil }
        return SessionKey(stringValue: session)
    }
}
