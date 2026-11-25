import Foundation

// DESIGN.md 8.12, New layout stage 2: a Duck's view is the chat plus a slim icon rail; clicking a rail icon opens a work
// pane beside the chat (Changes, Files, Canvas or Terminal). Everything the window needs to decide about it lives here,
// pure: which view shows, open and close, the pin, and each Duck's remembered view and width. The views only draw.

/// What the work pane can show. The rail lists them in this order.
public enum WorkPaneView: String, CaseIterable, Codable, Identifiable, Sendable {
    case changes, files, canvas, terminal
    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .changes: "Changes"
        case .files: "Files"
        case .canvas: "Canvas"
        case .terminal: "Terminal"
        }
    }

    /// An SF Symbol for the rail and the pane header.
    public var symbol: String {
        switch self {
        case .changes: "plus.forwardslash.minus"
        case .files: "folder"
        case .canvas: "square.on.square.dashed"
        case .terminal: "terminal"
        }
    }
}

public enum WorkPaneMetrics {
    public static let railWidth: Double = 52
    public static let defaultWidth: Double = 420
    public static let range: ClosedRange<Double> = 300...720

    /// The width to draw: the Duck's remembered one inside its range, held back so the chat keeps its minimum beside the
    /// sidebar and the rail.
    public static func drawn(stored: Double?, window: Double, sidebar: Double) -> Double {
        PaneWidths.effective(stored ?? defaultWidth, range: range, fallback: defaultWidth, window: window, otherPane: sidebar + railWidth)
    }

    /// A rail count: nothing for zero, "99+" past 99.
    public static func badge(count: Int?) -> String? {
        guard let count, count > 0 else { return nil }
        return count > 99 ? "99+" : String(count)
    }

    /// One key per Duck: its id (the Duck follows its chats), else the chat's own key.
    public static func duckKey(duckId: String?, sessionKey: String) -> String {
        if let duckId, !duckId.isEmpty { return "duck:\(duckId)" }
        return "chat:\(sessionKey)"
    }
}

/// The pane's state for one window. Open or closed is session state (never saved); the pin, each Duck's last view and its
/// width are saved. The pane opens only when a caller says so (`open`, `toggle`): `switched` and `setWidth` never open it.
public struct WorkPane: Equatable, Codable, Sendable {
    public struct Memory: Equatable, Codable, Sendable {
        public var view: WorkPaneView
        public var width: Double?
    }

    public private(set) var pinned = false
    public private(set) var memory: [String: Memory] = [:]
    public private(set) var isOpen = false
    /// The Duck on screen.
    public private(set) var current: String?

    public init() {}

    private enum CodingKeys: String, CodingKey { case pinned, memory }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pinned = (try? c.decodeIfPresent(Bool.self, forKey: .pinned)) ?? false
        memory = (try? c.decodeIfPresent([String: Memory].self, forKey: .memory)) ?? [:]
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(pinned, forKey: .pinned)
        try c.encode(memory, forKey: .memory)
    }

    /// The view on screen for the current Duck; nil while the pane is closed.
    public var shown: WorkPaneView? {
        guard isOpen, let current else { return nil }
        return memory[current]?.view ?? .changes
    }

    /// The width stored for a Duck (nil = the default).
    public func storedWidth(duck: String) -> Double? { memory[duck]?.width }

    /// The window now shows `duck`. Unpinned, the pane closes (it belongs to the Duck it was opened on); pinned, it stays
    /// open and shows this Duck's last view, or, for a Duck that never had one, the view that was showing.
    public mutating func switched(to duck: String) {
        guard duck != current else { return }
        let carried = shown
        current = duck
        if !pinned { isOpen = false; return }
        if isOpen, memory[duck] == nil, let carried { memory[duck] = Memory(view: carried, width: nil) }
    }

    /// Opens `view` for `duck` (an icon, or a Duck opening something: a shown file, a canvas, a diff). Selects the Duck.
    public mutating func open(_ view: WorkPaneView, duck: String) {
        current = duck
        isOpen = true
        memory[duck, default: Memory(view: view, width: nil)].view = view
    }

    /// A rail icon: opens that view, or closes the pane when it is the one showing.
    public mutating func toggle(_ view: WorkPaneView, duck: String) {
        if current == duck, shown == view { close() } else { open(view, duck: duck) }
    }

    public mutating func close() { isOpen = false }

    public mutating func setPinned(_ on: Bool) { pinned = on }

    /// A dragged width, kept for that Duck inside the range. Opens nothing.
    public mutating func setWidth(_ width: Double, duck: String) {
        guard width.isFinite else { return }
        let w = min(max(width, WorkPaneMetrics.range.lowerBound), WorkPaneMetrics.range.upperBound)
        memory[duck, default: Memory(view: .changes, width: nil)].width = w
    }

    /// Back to the default width for that Duck.
    public mutating func resetWidth(duck: String) { memory[duck]?.width = nil }

    /// Drops what is remembered for Ducks no longer there.
    public mutating func forget(keeping live: Set<String>) {
        memory = memory.filter { live.contains($0.key) }
    }
}
