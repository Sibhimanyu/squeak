import Foundation

// DESIGN.md 8.12: the side work pane beside the centre holds one thing, the Terminal. Changes, Files and Artifacts are
// one-shot popover lists from the rail (`RailTool`) that open items as tabs. Everything the window needs to decide about
// the pane lives here, pure: open and close, and each page's remembered width. The views only draw.

/// What the work pane can show: the Terminal, its only use. Older saved values (changes, files, canvas, artifacts) read back as it.
public enum WorkPaneView: String, CaseIterable, Codable, Identifiable, Sendable {
    case terminal
    public var id: String { rawValue }

    public init(from decoder: Decoder) throws { self = .terminal }

    public var title: String { "Terminal" }
    public var symbol: String { "terminal" }
}

public enum WorkPaneMetrics {
    public static let railWidth: Double = 52
    public static let defaultWidth: Double = 420
    public static let range: ClosedRange<Double> = 300...720

    /// The width to draw: the page's remembered one inside its range, held back so the chat keeps its minimum beside the
    /// sidebar and the rail.
    public static func drawn(stored: Double?, window: Double, sidebar: Double) -> Double {
        PaneWidths.effective(stored ?? defaultWidth, range: range, fallback: defaultWidth, window: window, otherPane: sidebar + railWidth)
    }

    /// A rail count: nothing for zero, "99+" past 99.
    public static func badge(count: Int?) -> String? {
        guard let count, count > 0 else { return nil }
        return count > 99 ? "99+" : String(count)
    }

    /// One key per Pond (its project id), for the Pond-scoped pane in the Room.
    public static func pondKey(projectId: String) -> String { "pond:\(projectId)" }

    /// One key per Duck: its id (the Duck follows its chats), else the chat's own key.
    public static func duckKey(duckId: String?, sessionKey: String) -> String {
        if let duckId, !duckId.isEmpty { return "duck:\(duckId)" }
        return "chat:\(sessionKey)"
    }
}

/// The pane's state for one window. Open or closed is session state (never saved); each page's width is saved. The pane
/// opens only when a caller says so (`open`, `toggle`): `switched` and `setWidth` never open it, and switching page closes it.
public struct WorkPane: Equatable, Codable, Sendable {
    public struct Memory: Equatable, Codable, Sendable {
        public var view: WorkPaneView
        public var width: Double?
    }

    public private(set) var memory: [String: Memory] = [:]
    public private(set) var isOpen = false
    /// The page on screen (a Duck or a Pond).
    public private(set) var current: String?

    public init() {}

    private enum CodingKeys: String, CodingKey { case memory }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        memory = (try? c.decodeIfPresent([String: Memory].self, forKey: .memory)) ?? [:]
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(memory, forKey: .memory)
    }

    /// The view on screen for the current page; nil while the pane is closed.
    public var shown: WorkPaneView? { isOpen && current != nil ? .terminal : nil }

    /// The width stored for a page (nil = the default).
    public func storedWidth(duck: String) -> Double? { memory[duck]?.width }

    /// The window now shows `duck`: the pane closes (it belongs to the page it was opened on).
    public mutating func switched(to duck: String) {
        guard duck != current else { return }
        current = duck
        isOpen = false
    }

    /// Opens the pane for `duck` (the Terminal icon, or a shell opened there). Selects the page.
    public mutating func open(_ view: WorkPaneView, duck: String) {
        current = duck
        isOpen = true
        memory[duck, default: Memory(view: view, width: nil)].view = view
    }

    /// The Terminal icon: opens the pane, or closes it when it is showing.
    public mutating func toggle(_ view: WorkPaneView, duck: String) {
        if current == duck, shown == view { close() } else { open(view, duck: duck) }
    }

    public mutating func close() { isOpen = false }

    /// A dragged width, kept for that page inside the range. Opens nothing.
    public mutating func setWidth(_ width: Double, duck: String) {
        guard width.isFinite else { return }
        let w = min(max(width, WorkPaneMetrics.range.lowerBound), WorkPaneMetrics.range.upperBound)
        memory[duck, default: Memory(view: .terminal, width: nil)].width = w
    }

    /// Back to the default width for that page.
    public mutating func resetWidth(duck: String) { memory[duck]?.width = nil }

    /// Drops what is remembered for pages no longer there.
    public mutating func forget(keeping live: Set<String>) {
        memory = memory.filter { live.contains($0.key) }
    }
}
