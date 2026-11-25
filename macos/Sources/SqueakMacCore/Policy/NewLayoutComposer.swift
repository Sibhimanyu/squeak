import Foundation

/// DESIGN.md §8.12 stage 3 (new layout only): the pure decisions behind the composer's chip and the hover action bar.

/// When the small action bar over a message (time, duration, Copy, "…") is drawn. It shows while the pointer is over the
/// message and while any of its controls has the keyboard, so a keyboard or VoiceOver user reaches Copy without a pointer.
/// A pressed menu keeps it up so it does not vanish under the person's hand.
public struct MessageActionBarState: Equatable, Sendable {
    public var hovering = false
    public var focusWithin = false
    public var menuOpen = false

    public init(hovering: Bool = false, focusWithin: Bool = false, menuOpen: Bool = false) {
        self.hovering = hovering
        self.focusWithin = focusWithin
        self.menuOpen = menuOpen
    }

    public var isVisible: Bool { hovering || focusWithin || menuOpen }

    /// The opacity the bar is drawn at. It is always in the view tree (so Tab can reach Copy) and never takes layout:
    /// only this value changes, which cannot move a message.
    public var opacity: Double { isVisible ? 1 : 0 }
}

/// The model chip above the new composer's field: "Pip · Opus 5.5 · Medium", tapping it opens the model picker.
public enum ComposerChip {
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
