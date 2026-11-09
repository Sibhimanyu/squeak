import Foundation

/// One key chord: modifiers plus a key as it is drawn on a keycap ("K", "↵", "⌫", "Tab", "1–9").
public struct KeyChord: Hashable, Sendable {
    public struct Modifiers: OptionSet, Hashable, Sendable {
        public let rawValue: Int
        public init(rawValue: Int) { self.rawValue = rawValue }
        public static let control = Modifiers(rawValue: 1)
        public static let option = Modifiers(rawValue: 2)
        public static let shift = Modifiers(rawValue: 4)
        public static let command = Modifiers(rawValue: 8)
    }

    public var modifiers: Modifiers
    public var key: String

    public init(_ key: String, _ modifiers: Modifiers = []) {
        self.key = key
        self.modifiers = modifiers
    }

    /// macOS's order: ⌃ ⌥ ⇧ ⌘, then the key ("⇧⌘N", "⌘⌥/").
    public var display: String {
        var s = ""
        if modifiers.contains(.control) { s += "⌃" }
        if modifiers.contains(.option) { s += "⌥" }
        if modifiers.contains(.shift) { s += "⇧" }
        if modifiers.contains(.command) { s += "⌘" }
        return s + key
    }
}

/// Every shortcut the workbench names (DESIGN.md §8.10, "Keyboard map"). The sheet (⌘⌥/) and the palette's
/// keycaps both read this one list, so a key is changed in one place; a shortcut editor would store overrides
/// keyed by `id` and ask `chords(for:overrides:)`.
public enum ShortcutID: String, CaseIterable, Sendable, Hashable {
    case palette, settings, shortcutList
    case toggleSidebar, toggleInspector, toggleTerminal
    case newChat, newWorkspace, openSession
    case newTab
    case forkChat
    case send, newline, steer, cyclePermission
    case stop
    case allowOnce, allowForChat, deny, approvePlan, keepPlanning, answer, answerOther
    case inspectorChanges, inspectorFiles, inspectorActivity, inspectorPR
    case gitCreatePR, gitCommitPush, gitMerge, gitFixErrors, gitReview
    case terminalNewTab, terminalClear
}

public struct ShortcutEntry: Hashable, Sendable, Identifiable {
    public var id: ShortcutID
    public var area: String
    public var title: String
    /// Alternates read left to right ("⌘." and "⌘⇧⌫" both stop).
    public var chords: [KeyChord]

    public var display: String { chords.map(\.display).joined(separator: " · ") }
}

public enum ShortcutRegistry {
    private static let c = KeyChord.Modifiers.command
    private static let o = KeyChord.Modifiers.option
    private static let s = KeyChord.Modifiers.shift

    /// The areas, in the order the sheet shows them.
    public static let areas = ["General", "Panes", "Workspace", "Chat tabs", "Chat", "Composer", "Cards", "Inspector", "Git", "Terminal"]

    public static let all: [ShortcutEntry] = [
        e(.palette, "General", "Command palette", KeyChord("K", c)),
        e(.settings, "General", "Settings", KeyChord(",", c)),
        e(.shortcutList, "General", "Keyboard shortcuts", KeyChord("/", [c, o])),
        e(.toggleSidebar, "Panes", "Toggle sidebar", KeyChord("B", c), KeyChord("\\", c)),
        e(.toggleInspector, "Panes", "Toggle inspector", KeyChord("B", [c, o])),
        e(.toggleTerminal, "Panes", "Toggle terminal", KeyChord("J", c)),
        e(.newChat, "Workspace", "New chat", KeyChord("N", c)),
        e(.newWorkspace, "Workspace", "New workspace", KeyChord("N", [c, s])),
        e(.openSession, "Workspace", "Open session 1–9", KeyChord("1–9", c)),
        e(.newTab, "Chat tabs", "New chat tab", KeyChord("T", c)),
        e(.forkChat, "Chat", "Fork this chat at its latest message", KeyChord("↵", [c, o])),
        e(.stop, "Chat", "Stop the turn", KeyChord(".", c)),
        e(.send, "Composer", "Send or queue", KeyChord("↵")),
        e(.newline, "Composer", "New line", KeyChord("↵", s)),
        e(.steer, "Composer", "Steer now", KeyChord("↵", [c, s])),
        e(.cyclePermission, "Composer", "Cycle permission mode", KeyChord("Tab", s)),
        e(.allowOnce, "Cards", "Allow once", KeyChord("↵")),
        e(.allowForChat, "Cards", "Allow for this chat", KeyChord("↵", c)),
        e(.deny, "Cards", "Deny", KeyChord("⌫"), KeyChord("⌫", c)),
        e(.approvePlan, "Cards", "Approve plan", KeyChord("↵"), KeyChord("↵", c), KeyChord("↵", [c, s])),
        e(.keepPlanning, "Cards", "Keep planning", KeyChord("⌫")),
        e(.answer, "Cards", "Answer a question", KeyChord("1–9")),
        e(.answerOther, "Cards", "Answer in other words", KeyChord("0")),
        e(.inspectorChanges, "Inspector", "Changes", KeyChord("1", [c, o])),
        e(.inspectorFiles, "Inspector", "Files", KeyChord("2", [c, o])),
        e(.inspectorActivity, "Inspector", "Activity", KeyChord("3", [c, o])),
        e(.inspectorPR, "Inspector", "PR (Squeak chats)", KeyChord("4", [c, o])),
        e(.gitCommitPush, "Git", "Commit and push (Squeak chats)", KeyChord("Y", [c, s])),
        e(.gitCreatePR, "Git", "Create PR", KeyChord("P", [c, s])),
        e(.gitMerge, "Git", "Merge", KeyChord("M", [c, s])),
        e(.gitFixErrors, "Git", "Fix errors", KeyChord("X", [c, s])),
        e(.gitReview, "Git", "Review", KeyChord("R", [c, s])),
        e(.terminalNewTab, "Terminal", "New terminal tab", KeyChord("T", c)),
        e(.terminalClear, "Terminal", "Clear (terminal focused)", KeyChord("K", c)),
    ]

    private static func e(_ id: ShortcutID, _ area: String, _ title: String, _ chords: KeyChord...) -> ShortcutEntry {
        ShortcutEntry(id: id, area: area, title: title, chords: chords)
    }

    public static func entry(_ id: ShortcutID) -> ShortcutEntry? { all.first { $0.id == id } }

    /// The chords for a shortcut, an override (a future editor's) first.
    public static func chords(for id: ShortcutID, overrides: [ShortcutID: [KeyChord]] = [:]) -> [KeyChord] {
        overrides[id] ?? entry(id)?.chords ?? []
    }

    /// The keycap text for a row: the first chord only ("⌘B").
    public static func keycap(_ id: ShortcutID, overrides: [ShortcutID: [KeyChord]] = [:]) -> String? {
        chords(for: id, overrides: overrides).first?.display
    }

    /// The sheet's sections: areas in fixed order, entries in registry order, empty areas dropped.
    public static func sections(matching query: String = "") -> [(area: String, entries: [ShortcutEntry])] {
        let q = PaletteMatch.fold(query).trimmingCharacters(in: .whitespaces)
        return areas.compactMap { area in
            let list = all.filter { entry in
                guard entry.area == area else { return false }
                guard !q.isEmpty else { return true }
                return PaletteMatch.score(q, in: PaletteMatch.fold(entry.title + " " + entry.area + " " + entry.display)) != nil
            }
            return list.isEmpty ? nil : (area, list)
        }
    }
}
