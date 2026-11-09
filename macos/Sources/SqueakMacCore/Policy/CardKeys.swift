import Foundation

/// DESIGN.md §8.10 "Keyboard map": the bare keys of a card that waits on you (↵ allow or approve, ⌫ deny or keep
/// planning, 1–9 answer, 0 your own). The ⌘ variants are real key equivalents and need no rule here; the bare ones
/// would otherwise be taken from a text field, so they act only when typing is not what the key means. Pure, so
/// CI can say exactly when a key is the card's.
public enum CardKeys {
    public enum Card: Equatable, Sendable { case approval, plan, question }

    /// What was pressed (no modifier held: the caller checks that).
    public enum Key: Equatable, Sendable {
        case returnKey, delete
        /// 0 is "Other", 1–9 are options.
        case digit(Int)
    }

    /// Where keyboard focus is.
    public enum Focus: Equatable, Sendable {
        /// No text field (the transcript, a button, the window itself).
        case none
        /// The chat's composer.
        case composer
        /// Any other editable text (search, a rename, a sheet's field).
        case otherField
    }

    public enum Action: Equatable, Sendable {
        case allowOnce, deny, approvePlan, keepPlanning
        /// Zero-based option index.
        case answer(Int)
        case other
    }

    /// The card's action for a bare key, or nil when the key is not the card's: the card is busy answering, focus is
    /// in some other text field, or the composer holds words (↵ then sends them as the deny/answer, ⌫ deletes).
    public static func action(key: Key, card: Card, optionCount: Int, focus: Focus, composerHasText: Bool, busy: Bool = false) -> Action? {
        guard !busy else { return nil }
        switch focus {
        case .otherField: return nil
        case .composer: if composerHasText { return nil }
        case .none: break
        }
        switch (card, key) {
        case (.approval, .returnKey): return .allowOnce
        case (.approval, .delete): return .deny
        case (.plan, .returnKey): return .approvePlan
        case (.plan, .delete): return .keepPlanning
        case (.question, .digit(0)): return .other
        case (.question, .digit(let n)): return (1...9).contains(n) && n <= optionCount ? .answer(n - 1) : nil
        default: return nil
        }
    }

    /// The key a typed character is, for `NSEvent.charactersIgnoringModifiers`.
    public static func digit(_ characters: String?) -> Key? {
        guard let c = characters, c.count == 1, let n = Int(c), (0...9).contains(n) else { return nil }
        return .digit(n)
    }
}

/// The keycaps a card shows, one place, so the cards, the hint line and DESIGN.md §8.10 cannot drift apart.
/// Allow once is the bare ↵; ⌘↵ is the wider choice (the whole chat), so a stray ⌘ press never gives more than a tap.
public enum CardKeycaps {
    public static let allowOnce = "↵"
    public static let allowSession = "⌘↵"
    public static let deny = "⌫"
    public static let approvePlan = "↵"
    public static let keepPlanning = "⌫"
}
