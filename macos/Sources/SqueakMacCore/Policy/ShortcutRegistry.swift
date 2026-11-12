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
    case toggleSidebar, toggleInspector, toggleCode, toggleTerminal, zenMode, fullScreen
    case newChat, newWorkspace, openSession, home, previousWorkspace, nextWorkspace, pinRow, readRow, movePondUp, movePondDown
    case newTab, reopenTab, closeTab, nextTab, previousTab, diffView
    case nextAttention, expandTools, focusComposer
    case forkChat
    case send, newline, steer, cyclePermission, modelPicker, effortPicker, attach, dictate
    case stop
    case allowOnce, allowForChat, deny, approvePlan, keepPlanning, answer, answerOther
    case inspectorTabs
    case gitCreatePR, gitCommitPush, gitMerge, gitFixErrors, gitReview, gitPullLatest
    case terminalNewTab, terminalClear, terminalLeave
}

/// Where a chord is live. Two shortcuts may share a chord only in different scopes (↵ sends in the composer and
/// allows on a tool card); within one scope a chord is one action, and a test fails on a duplicate.
public enum ShortcutScope: String, Sendable, Hashable {
    case window, composer, toolCard, planCard, questionCard, sidebarRow, terminal
}

public struct ShortcutEntry: Hashable, Sendable, Identifiable {
    public var id: ShortcutID
    public var scope: ShortcutScope {
        switch id {
        case .send, .newline, .steer, .cyclePermission, .modelPicker, .effortPicker, .attach, .dictate: .composer
        case .allowOnce, .allowForChat, .deny: .toolCard
        case .approvePlan, .keepPlanning: .planCard
        case .answer, .answerOther: .questionCard
        case .pinRow, .readRow: .sidebarRow
        case .terminalNewTab, .terminalClear, .terminalLeave: .terminal
        default: .window
        }
    }
    public var area: String
    public var title: String
    /// Alternates read left to right ("⌘." and "⌘⇧⌫" both stop).
    public var chords: [KeyChord]

    public var display: String { chords.map(\.display).joined(separator: " · ") }
}

/// Shortcuts follow where you are typing. A chord that means two things (⌘T, ⌘W, ⇧⌘T, ⌘K, ⌘L, ⌘1–9, ⌘[ ⌘], Esc)
/// is answered by `ShortcutFocus.action(_:in:terminalOpen:)` in FocusModel.swift; its table is documented there, and
/// the registry's entries only name the keys. The terminal panel shows when it holds the keys and a collapsed one never does.
public enum ShortcutRegistry {
    private static let c = KeyChord.Modifiers.command
    private static let o = KeyChord.Modifiers.option
    private static let s = KeyChord.Modifiers.shift

    /// The areas, in the order the sheet shows them.
    public static let areas = ["General", "Panes", "Stream", "Chat tabs", "Chat", "Composer", "Cards", "Inspector", "Git", "Terminal"]

    public static let all: [ShortcutEntry] = [
        e(.palette, "General", "Command palette", KeyChord("K", c)),
        e(.settings, "General", "Settings", KeyChord(",", c)),
        e(.shortcutList, "General", "Keyboard shortcuts", KeyChord("/", [c, o])),
        e(.toggleSidebar, "Panes", "Toggle sidebar", KeyChord("B", c), KeyChord("\\", c)),
        e(.toggleInspector, "Panes", "Toggle inspector", KeyChord("B", [c, o])),
        e(.toggleCode, "Panes", "Show the code tools or the pond panel", KeyChord("C", [c, o])),
        e(.toggleTerminal, "Panes", "Toggle terminal", KeyChord("J", c)),
        e(.fullScreen, "Panes", "Enter or leave full screen", KeyChord("F", [.control, c])),
        e(.zenMode, "Panes", "Zen mode (hide both side panes)", KeyChord(".", [c, s])),
        e(.newChat, "Stream", "New chat", KeyChord("N", c)),
        e(.newWorkspace, "Stream", "New stream", KeyChord("N", [c, s])),
        e(.openSession, "Stream", "Open session 1–9", KeyChord("1–9", c)),
        e(.home, "Stream", "Dashboard", KeyChord("H", [c, s])),
        e(.previousWorkspace, "Stream", "Previous stream", KeyChord("↑", [c, o])),
        e(.nextWorkspace, "Stream", "Next stream", KeyChord("↓", [c, o])),
        // ⌥⌘↑/↓ already step through streams, so a pond moves with ⌃⌘↑/↓.
        e(.movePondUp, "Stream", "Move the open pond up in your order", KeyChord("↑", [.control, c])),
        e(.movePondDown, "Stream", "Move the open pond down in your order", KeyChord("↓", [.control, c])),
        e(.pinRow, "Stream", "Pin or unpin the focused stream", KeyChord("P")),
        e(.readRow, "Stream", "Mark the focused stream read or unread", KeyChord("R")),
        e(.newTab, "Chat tabs", "New chat tab", KeyChord("T", c)),
        e(.reopenTab, "Chat tabs", "Reopen closed tab", KeyChord("T", [c, s])),
        // ⌘W closes the open tab; with no tab to close it closes the window (CloseRouting).
        e(.closeTab, "Chat tabs", "Close tab", KeyChord("W", c)),
        e(.nextTab, "Chat tabs", "Next tab", KeyChord("Tab", .control)),
        e(.previousTab, "Chat tabs", "Previous tab", KeyChord("Tab", [.control, s])),
        // ⇧⌘D is dictation and ⇧⌘/ is macOS's Help search, so the diff view and effort take ⇧⌘G and ⇧⌘E.
        e(.diffView, "Chat tabs", "View all changes (review)", KeyChord("G", [c, s])),
        e(.nextAttention, "Chat", "Next chat that needs you", KeyChord("L", [c, o])),
        e(.expandTools, "Chat", "Expand or fold every step", KeyChord("O", .control)),
        e(.forkChat, "Chat", "Fork this chat at its latest message", KeyChord("↵", [c, o])),
        e(.stop, "Chat", "Stop the turn", KeyChord(".", c)),
        e(.focusComposer, "Composer", "Focus the message field", KeyChord("L", c)),
        e(.send, "Composer", "Send (queue while the agent works)", KeyChord("↵")),
        e(.newline, "Composer", "New line", KeyChord("↵", s)),
        e(.steer, "Composer", "Steer now (while the agent works)", KeyChord("↵", c)),
        e(.modelPicker, "Composer", "Model picker", KeyChord("/", c)),
        e(.effortPicker, "Composer", "Next thinking level", KeyChord("E", [c, s])),
        e(.attach, "Composer", "Attach images", KeyChord("U", c)),
        e(.dictate, "Composer", "Dictate (spoken on this Mac)", KeyChord("D", [c, s])),
        e(.cyclePermission, "Composer", "Cycle permission mode", KeyChord("Tab", s)),
        e(.allowOnce, "Cards", "Allow once", KeyChord("↵")),
        e(.allowForChat, "Cards", "Allow for this chat", KeyChord("↵", c)),
        e(.deny, "Cards", "Deny", KeyChord("⌫"), KeyChord("⌫", c)),
        e(.approvePlan, "Cards", "Approve plan", KeyChord("↵"), KeyChord("↵", c), KeyChord("↵", [c, s])),
        e(.keepPlanning, "Cards", "Keep planning", KeyChord("⌫")),
        e(.answer, "Cards", "Answer a question", KeyChord("1–9")),
        e(.answerOther, "Cards", "Answer in other words", KeyChord("0")),
        e(.inspectorTabs, "Inspector", "Tabs in order: All files, Changes, Review", KeyChord("1–3", [c, o])),
        e(.gitCommitPush, "Git", "Commit and push (Squeak chats)", KeyChord("Y", [c, s])),
        e(.gitCreatePR, "Git", "Create PR", KeyChord("P", [c, s])),
        e(.gitMerge, "Git", "Merge", KeyChord("M", [c, s])),
        e(.gitFixErrors, "Git", "Fix errors", KeyChord("X", [c, s])),
        e(.gitReview, "Git", "Review", KeyChord("R", [c, s])),
        e(.gitPullLatest, "Git", "Pull latest (Squeak chats)", KeyChord("L", [c, s])),
        e(.terminalNewTab, "Terminal", "New terminal tab", KeyChord("T", c)),
        e(.terminalClear, "Terminal", "Clear (terminal focused)", KeyChord("K", c)),
        e(.terminalLeave, "Terminal", "Back to the message field (also ⌘L)", KeyChord("`", .control)),
    ]

    private static func e(_ id: ShortcutID, _ area: String, _ title: String, _ chords: KeyChord...) -> ShortcutEntry {
        ShortcutEntry(id: id, area: area, title: title, chords: chords)
    }

    /// The control's hover label: "Hide sidebar  ⌘B".
    public static func hint(_ name: String, _ id: ShortcutID, overrides: [ShortcutID: [KeyChord]] = [:]) -> String {
        guard let key = keycap(id, overrides: overrides) else { return name }
        return "\(name)  \(key)"
    }

    /// Chords that two shortcuts share inside one scope: empty when the registry is sound.
    public static func duplicates() -> [String] {
        var seen: [String: ShortcutID] = [:]
        var found: [String] = []
        for entry in all {
            for chord in entry.chords {
                let key = "\(entry.scope.rawValue)|\(chord.display)"
                if let other = seen[key], other != entry.id { found.append("\(chord.display) in \(entry.scope.rawValue): \(other.rawValue), \(entry.id.rawValue)") }
                seen[key] = entry.id
            }
        }
        return found
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
