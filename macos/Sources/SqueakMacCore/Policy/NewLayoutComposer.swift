import Foundation

/// DESIGN.md §8.12 stage 3 (new layout only): the pure decisions behind the composer's chip and the hover action bar.

/// When the quiet actions row under an assistant reply (muted time and duration, Copy, "...") is drawn. The row sits directly
/// under the message's last line, left-aligned with the text, and it always owns `reservedHeight` points whether drawn or
/// not, so showing it never moves a message and it never covers text. It shows while the pointer is over the message, while
/// any of its controls has the keyboard (so Tab and VoiceOver reach Copy without a pointer), while its menu is open, and at
/// rest on the newest finished reply of the chat.
public struct MessageActionBarState: Equatable, Sendable {
    public var hovering = false
    public var focusWithin = false
    public var menuOpen = false
    /// The newest finished assistant reply of the chat: its row stays drawn at rest.
    public var isNewest = false

    public init(hovering: Bool = false, focusWithin: Bool = false, menuOpen: Bool = false, isNewest: Bool = false) {
        self.hovering = hovering
        self.focusWithin = focusWithin
        self.menuOpen = menuOpen
        self.isNewest = isNewest
    }

    /// Height the row always takes under the message (points), drawn or not.
    public static let reservedHeight: Double = 28
    /// Gap between the message's last line and the row.
    public static let gapAbove: Double = 2

    public var isVisible: Bool { hovering || focusWithin || menuOpen || isNewest }

    /// The opacity the row is drawn at. It is always in the view tree (so Tab can reach Copy) and always takes its height:
    /// only this value changes, which cannot move a message.
    public var opacity: Double { isVisible ? 1 : 0 }

    /// The newest finished reply: the last message that closes a turn (has a footer).
    public static func newestID(in messages: [ChatMessage], footers: [String: TurnFooter]) -> String? {
        messages.last { footers[$0.id] != nil }?.id
    }
}

/// The model chip above the new composer's field: "Pip · Opus 5.5 · Medium", tapping it opens the model picker.
public enum ComposerChip {
    /// The name the chip leads with: the host's name for the session's Duck (matched by Duck id, else by its current chat).
    /// Only a session with no Duck falls back to the chat title; a Duck whose roster has not arrived yet shows no name
    /// rather than flashing the chat title (never a name the app made up).
    public static func duckName(duckId: String?, sessionId: String, ducks: [PondDuck]?, chatTitle: String) -> String? {
        guard let duckId, !duckId.isEmpty else { return chatTitle }
        let duck = ducks?.first { $0.id == duckId } ?? ducks?.first { $0.currentSessionId == sessionId }
        return duck?.name
    }

    /// The words, dropping any part that is unknown; the duck's name is clipped so a long title never fills the line.
    public static func line(duck: String?, model: String?, effort: String?, limit: Int = 24) -> String {
        let name = duck?.trimmingCharacters(in: .whitespacesAndNewlines).split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let clipped = name.count > limit ? String(name.prefix(limit - 1)) + "\u{2026}" : name
        return [clipped, model ?? "", effort ?? ""]
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " \u{00B7} ")
    }
}
