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

    public init() {}

    public func text(for key: SessionKey?) -> String {
        key.flatMap { byTarget[$0] } ?? ""
    }

    /// Whitespace-only text is not a draft.
    public mutating func stash(_ text: String, for key: SessionKey?) {
        guard let key else { return }
        byTarget[key] = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : text
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
