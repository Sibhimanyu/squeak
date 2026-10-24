import Foundation

/// What a composer does with the text in its box, kept free of UIKit so `swift test` covers it.
///
/// The rule: the box empties the moment a send is accepted locally, and the text is kept nowhere
/// afterwards (not in the saved drafts either, which would bring it back on the next visit). It
/// returns only if the send definitively did not happen.
public enum DraftPolicy {
    /// The box after a send that did not happen: the text back, in front of anything typed since.
    public static func restoring(_ text: String, into current: String) -> String {
        if current.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return text }
        if current == text { return current }
        return text + "\n" + current
    }

    /// Whether the text to send is worth sending at all.
    public static func isSendable(_ text: String, hasPhotos: Bool = false) -> Bool {
        hasPhotos || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// Drafts kept across leaving a chat and relaunching, one per chat. Local to the phone.
public struct DraftStore {
    private let defaults: UserDefaults
    private let key = "squeak.drafts"

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    public func draft(for chat: String) -> String {
        (defaults.dictionary(forKey: key) as? [String: String])?[chat] ?? ""
    }

    /// A blank draft removes the entry rather than storing it.
    public func save(_ draft: String, for chat: String) {
        var drafts = (defaults.dictionary(forKey: key) as? [String: String]) ?? [:]
        if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { drafts[chat] = nil } else { drafts[chat] = draft }
        defaults.set(drafts, forKey: key)
    }
}
