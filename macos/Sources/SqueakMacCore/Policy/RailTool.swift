import Foundation

// DESIGN.md 8.12: the one rail on the right of the Dashboard, the Room and every Duck. Each icon is a tool: Changes, Files,
// Artifacts and Tasks open a one-shot popover list; the Notebook opens as a tab; the Terminal opens the side pane, whose
// only use it is. Pure, so the order, what each icon opens and the room for all six are tested rather than drawn.

public enum RailTool: String, CaseIterable, Identifiable, Sendable {
    case changes, files, artifacts, tasks, notebook, terminal
    public var id: String { rawValue }

    /// What picking the icon does.
    public enum Opens: Equatable, Sendable {
        /// A one-shot list anchored to the icon; picking an item opens it as a tab and closes the list. Nothing pins it.
        case popover
        /// A tab in the centre.
        case tab
        /// The side pane beside the centre (the Terminal).
        case pane
    }

    public var opens: Opens {
        switch self {
        case .changes, .files, .artifacts, .tasks: .popover
        case .notebook: .tab
        case .terminal: .pane
        }
    }

    public var title: String {
        switch self {
        case .changes: "Changes"
        case .files: "Files"
        case .artifacts: "Artifacts"
        case .tasks: "Tasks"
        case .notebook: "Notebook"
        case .terminal: "Terminal"
        }
    }

    public var symbol: String {
        switch self {
        case .changes: "plus.forwardslash.minus"
        case .files: "folder"
        case .artifacts: "photo.on.rectangle"
        case .tasks: "checklist"
        case .notebook: "book.closed"
        case .terminal: "terminal"
        }
    }

    /// The icons drawn, in rail order: all six.
    public static var shown: [RailTool] { allCases }
}

public enum RailMetrics {
    public static let iconSize: Double = 40
    public static let spacing: Double = 6
    public static let topPadding: Double = 8

    /// The rail's height for `icons` icons.
    public static func height(icons: Int) -> Double {
        guard icons > 0 else { return 0 }
        return topPadding + Double(icons) * iconSize + Double(icons - 1) * spacing
    }

    /// All six tools fit a window of this height (the window's minimum content height is 620).
    public static func fits(icons: Int, windowHeight: Double) -> Bool { height(icons: icons) <= windowHeight }
}
