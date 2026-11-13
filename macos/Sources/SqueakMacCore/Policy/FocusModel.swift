import Foundation

/// Where the keyboard is. Shortcuts follow focus (the owner's rule), so every chord that means something in two
/// places is answered here, in one table, and the app only enacts the answer. DESIGN.md §8.10, "Keyboard map".
public enum FocusRegion: String, CaseIterable, Sendable, Hashable {
    case composer, transcript, terminal, fileViewer, review, sidebar, quickComposer

    /// A collapsed or hidden terminal panel can never hold the keys: its region is the composer's.
    public func effective(terminalOpen: Bool) -> FocusRegion {
        self == .terminal && !terminalOpen ? .composer : self
    }
}

/// The chords whose meaning depends on focus.
public enum FocusChord: Hashable, Sendable {
    case newTab            // ⌘T: always a chat tab
    case newTerminalTab    // ⌃⇧`: a terminal tab, from anywhere
    case reopenTab         // ⇧⌘T
    case close             // ⌘W
    case session(Int)      // ⌘1–9
    case palette           // ⌘K
    case focusComposer     // ⌘L
    case back, forward     // ⌘[ ⌘]
    case escape            // Esc
    case leaveTerminal     // ⌃`
}

public enum FocusAction: Hashable, Sendable {
    case newThread, newTerminal
    case reopenChatTab
    case closeChatTab, closeFileTab, closeReview, closeTerminalTab, closeWindow
    case openSession(Int)
    case openPalette, clearTerminal
    case focusComposer
    case navigateBack, navigateForward
    /// The chord is not Squeak's here: the focused control (the shell, the editor, the quick composer) gets it.
    case passThrough
}

public enum ShortcutFocus {
    /// The table. Rows are chords, columns regions:
    ///
    /// | chord | composer / transcript / sidebar | terminal | file viewer | review | quick composer |
    /// |-------|----------------------------------|----------|-------------|--------|----------------|
    /// | ⌘T    | new thread                       | new thread (the owner: ⌘T is a chat tab everywhere) | new thread | new thread | pass |
    /// | ⌃⇧`   | new terminal                     | new terminal | new terminal | new terminal | pass |
    /// | ⇧⌘T   | reopen chat tab                  | reopen chat tab | same | same | pass |
    /// | ⌘W    | close chat tab                   | **close terminal tab** (last one hides the panel) | close file tab | close review | close window |
    /// | ⌘1–9  | open session                     | same | same | same | pass |
    /// | ⌘K    | palette                          | **clear terminal** | palette | palette | pass |
    /// | ⌘L    | focus message field              | focus message field (leaves terminal) | same | same | pass |
    /// | ⌘[ ⌘] | back / forward                   | same | pass (editor indent) | same | pass |
    /// | Esc   | pass                             | pass (the shell may be using it) | pass | pass | pass |
    /// | ⌃`    | pass                             | **back to the message field** | pass | pass | pass |
    ///
    /// A collapsed terminal is never the region (`FocusRegion.effective`).
    public static func action(_ chord: FocusChord, in region: FocusRegion, terminalOpen: Bool = true) -> FocusAction {
        let r = region.effective(terminalOpen: terminalOpen)
        if r == .quickComposer { return .passThrough }
        switch chord {
        case .newTab: return .newThread
        case .newTerminalTab: return .newTerminal
        case .reopenTab: return .reopenChatTab
        case .close:
            switch r {
            case .terminal: return .closeTerminalTab
            case .fileViewer: return .closeFileTab
            case .review: return .closeReview
            default: return .closeChatTab
            }
        case .session(let n): return (1...9).contains(n) ? .openSession(n) : .passThrough
        case .palette: return r == .terminal ? .clearTerminal : .openPalette
        case .focusComposer: return .focusComposer
        case .back: return r == .fileViewer ? .passThrough : .navigateBack
        case .forward: return r == .fileViewer ? .passThrough : .navigateForward
        case .escape: return .passThrough
        case .leaveTerminal: return r == .terminal ? .focusComposer : .passThrough
        }
    }

    /// What ⌘T does now, for the menu and the hints: always a chat tab.
    public static func newItemAction(in region: FocusRegion, terminalOpen: Bool) -> FocusAction {
        action(.newTab, in: region, terminalOpen: terminalOpen)
    }

    /// The new-terminal chord, shown on File › New Terminal and the terminal's + hint.
    public static let newTerminalChord = KeyChord("`", [.control, .shift]).display

    /// Where the keys go when the terminal panel collapses (⌘J, its chevron, closing its last tab): out of the
    /// hidden terminal to the message field; anywhere else they stay where they were.
    public enum CollapseFocus: Equatable, Sendable { case composer, keep }
    public static func focusAfterCollapse(from region: FocusRegion) -> CollapseFocus {
        region == .terminal ? .composer : .keep
    }

    public struct MenuItem: Equatable, Sendable {
        public var title: String
        /// The keycap, or nil when another item holds the chord right now.
        public var chord: String?
    }

    /// File › New Thread and New Terminal: each keeps its own chord whatever has focus.
    public static func newMenu(in region: FocusRegion, terminalOpen: Bool) -> (thread: MenuItem, terminal: MenuItem) {
        (MenuItem(title: "New Thread", chord: KeyChord("T", .command).display), MenuItem(title: "New Terminal", chord: newTerminalChord))
    }

    /// File › Close: names what ⌘W closes now.
    public static func closeTitle(in region: FocusRegion, terminalOpen: Bool) -> String {
        switch action(.close, in: region, terminalOpen: terminalOpen) {
        case .closeTerminalTab: "Close Terminal"
        case .closeFileTab: "Close File"
        case .closeReview: "Close Review"
        case .closeWindow: "Close Window"
        default: "Close Tab"
        }
    }

    /// The tab strip's + hover label.
    public static func newThreadHint(in region: FocusRegion, terminalOpen: Bool) -> String { "New thread  ⌘T" }

    /// The terminal's own + hover label.
    public static func newTerminalHint(in region: FocusRegion, terminalOpen: Bool) -> String {
        "New terminal  \(newTerminalChord)"
    }

    /// Shown in the terminal's title area while it has the keys; nil otherwise.
    public static func terminalTitleHint(in region: FocusRegion, terminalOpen: Bool) -> String? {
        region.effective(terminalOpen: terminalOpen) == .terminal ? "\(newTerminalChord) New terminal · ⌘W Close terminal" : nil
    }
}
