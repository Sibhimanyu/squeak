import Foundation

// DESIGN.md §8.10: the right zone always shows a tab strip, so whatever it shows is a tab and a terminal can always be
// added. Beside a pond page the first tab is the pinned Pond tab (it hosts the morphing pond inspector); beside a duck's
// stream it is the panel the zone showed before. Pure: the views feed state in and draw what comes back.

/// The kinds of right-zone tab that are remembered per pond. A terminal's identity is session state (a live shell), so
/// only its being the shown tab is saved.
public enum InspectorTabKind: String, Codable, CaseIterable, Sendable {
    case pond, code, files, artifacts, terminal
}

/// One tab in the right zone's strip.
public enum RightTab: Hashable, Sendable {
    /// The pond inspector; pinned first tab beside a pond page.
    case pond
    case code
    case files
    /// What the pond's ducks made to look at (shown files and design files); opened from the "+".
    case artifacts
    case terminal(UUID)
    /// A dockable panel the stream's zone already holds (Code, Thread, ...).
    case panel(DockPanel)

    public var kind: InspectorTabKind {
        switch self {
        case .pond: return .pond
        case .code, .panel: return .code
        case .files: return .files
        case .artifacts: return .artifacts
        case .terminal: return .terminal
        }
    }

    public var title: String {
        switch self {
        case .pond: return "Pond"
        case .code: return "Code"
        case .files: return "Files"
        case .artifacts: return "Artifacts"
        case .terminal: return "Terminal"
        case .panel(let p): return p.title
        }
    }

    /// An SF Symbol name; the Pond tab is the people icon.
    public var symbol: String {
        switch self {
        case .pond: return "person.2"
        case .code: return DockPanel.code.symbol
        case .files: return "folder"
        case .artifacts: return "photo.on.rectangle"
        case .terminal: return "terminal"
        case .panel(let p): return p.symbol
        }
    }
}

/// What is open beside one pond, saved in the dock layout: the Code and Files tabs in order, and the selected kind.
public struct InspectorTabsRecord: Codable, Equatable, Sendable {
    /// Code, Files and Artifacts only (the Pond tab is always there beside a pond; terminals are live shells).
    public var open: [InspectorTabKind]
    public var selected: InspectorTabKind

    public init(open: [InspectorTabKind] = [], selected: InspectorTabKind = .pond) {
        self.open = Self.cleaned(open)
        self.selected = selected
    }

    private enum CodingKeys: String, CodingKey { case open, selected }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = (try? c.decodeIfPresent([String].self, forKey: .open)) ?? []
        open = Self.cleaned(raw.compactMap(InspectorTabKind.init(rawValue:)))
        selected = ((try? c.decodeIfPresent(String.self, forKey: .selected)) ?? nil).flatMap(InspectorTabKind.init(rawValue:)) ?? .pond
    }

    private static func cleaned(_ kinds: [InspectorTabKind]) -> [InspectorTabKind] {
        var seen = Set<InspectorTabKind>()
        return kinds.filter { ($0 == .code || $0 == .files || $0 == .artifacts) && seen.insert($0).inserted }
    }

    /// Opens (or re-selects) Code or Files.
    public mutating func open(_ kind: InspectorTabKind) {
        guard kind == .code || kind == .files || kind == .artifacts else { selected = kind; return }
        if !open.contains(kind) { open.append(kind) }
        selected = kind
    }

    /// Closes Code or Files; the selection falls to the neighbour on its left (the Pond tab at worst).
    public mutating func close(_ kind: InspectorTabKind) {
        guard let i = open.firstIndex(of: kind) else { return }
        open.remove(at: i)
        if selected == kind { selected = i > 0 ? open[i - 1] : .pond }
    }
}

/// Where the strip is drawn: beside a pond page, or beside a duck's stream with the panels the zone holds.
public enum InspectorContext: Equatable, Sendable {
    case pond
    case stream(panels: [DockPanel])
}

/// What the "+" offers; the first is what a plain click does.
public enum InspectorPlusItem: String, CaseIterable, Sendable {
    case newTerminal, files, code, artifacts

    public var title: String {
        switch self {
        case .newTerminal: return "New terminal"
        case .files: return "Files"
        case .code: return "Code"
        case .artifacts: return "Artifacts"
        }
    }

    public var symbol: String {
        switch self {
        case .newTerminal: return "terminal"
        case .files: return "folder"
        case .code: return DockPanel.code.symbol
        case .artifacts: return "photo.on.rectangle"
        }
    }
}

public struct InspectorStrip: Equatable, Sendable {
    public var tabs: [RightTab]
    public var selected: RightTab
    /// The tab that cannot be closed or dragged out: always the first.
    public var pinned: RightTab

    /// The strip for a context. `terminals` are the shells placed in the right zone; `selectedTerminal` is the shown one.
    /// The strip is never empty: beside a pond the Pond tab is always first; in a stream the first panel the zone holds
    /// is (Code when it holds none).
    public static func make(
        context: InspectorContext, record: InspectorTabsRecord = InspectorTabsRecord(), terminals: [UUID] = [],
        selectedTerminal: UUID? = nil, selectedPanel: DockPanel? = nil, peopleOnly: Bool = false
    ) -> InspectorStrip {
        // A remote pond has no code on this Mac: the Pond tab (People, Recent) alone, whatever was saved.
        if peopleOnly, case .pond = context { return InspectorStrip(tabs: [.pond], selected: .pond, pinned: .pond) }
        var tabs: [RightTab] = []
        switch context {
        case .pond:
            // Artifacts always sits beside Pond (top right), never behind the "+" menu.
            tabs.append(.pond)
            tabs.append(.artifacts)
            for k in record.open {
                switch k {
                case .files: tabs.append(.files)
                case .artifacts: break
                default: tabs.append(.code)
                }
            }
        case .stream(let panels):
            let shown = panels.filter { $0 != .terminal }
            tabs = (shown.isEmpty ? [.code] : shown).map { .panel($0) }
        }
        tabs += terminals.map { .terminal($0) }
        let pinned = tabs[0]
        var selected = tabs[0]
        switch context {
        case .pond:
            if let t = selectedTerminal, terminals.contains(t) { selected = .terminal(t); break }
            switch record.selected {
            case .pond: selected = .pond
            case .code: selected = tabs.contains(.code) ? .code : .pond
            case .files: selected = tabs.contains(.files) ? .files : .pond
            case .artifacts: selected = tabs.contains(.artifacts) ? .artifacts : .pond
            case .terminal:
                if let t = selectedTerminal, terminals.contains(t) { selected = .terminal(t) } else if let f = terminals.first { selected = .terminal(f) }
            }
        case .stream:
            if let t = selectedTerminal, terminals.contains(t) { selected = .terminal(t) }
            else if let p = selectedPanel, tabs.contains(.panel(p)) { selected = .panel(p) }
        }
        return InspectorStrip(tabs: tabs, selected: selected, pinned: pinned)
    }

    /// Pinned: no close button, and it cannot be dragged out of the strip.
    public func isPinned(_ tab: RightTab) -> Bool { tab == pinned || tab == .artifacts }
    public func isClosable(_ tab: RightTab) -> Bool { !isPinned(tab) }
    public func isDraggable(_ tab: RightTab) -> Bool { !isPinned(tab) }

    /// The "+" menu, same in both contexts. Files and Code are left out of a pond's menu while open (they would only
    /// re-select), but never in a stream, where they are panels of the zone.
    public static func plusItems(context: InspectorContext, record: InspectorTabsRecord = InspectorTabsRecord(), peopleOnly: Bool = false) -> [InspectorPlusItem] {
        peopleOnly ? [] : InspectorPlusItem.allCases.filter { $0 != .artifacts }  // Artifacts is always in the strip
    }
    public static let plusDefault = InspectorPlusItem.newTerminal
}

public extension DockLayout {
    /// What is open beside a pond (its directory key); nothing saved yet = just the Pond tab.
    func inspectorRecord(pond key: String) -> InspectorTabsRecord { inspectorTabs[key] ?? InspectorTabsRecord() }

    mutating func setInspectorRecord(_ record: InspectorTabsRecord, pond key: String) {
        if record == InspectorTabsRecord() { inspectorTabs[key] = nil } else { inspectorTabs[key] = record }
    }
}

/// Which ponds the inspector has shown this session: the first visit selects the Pond tab, later ones keep the saved pick.
public struct InspectorVisits: Equatable, Sendable {
    private var seen = Set<String>()
    public init() {}

    /// The record to show for `key` now. First visit this session: the Pond tab is selected (the open tabs stay).
    public mutating func arrive(at key: String, record: InspectorTabsRecord) -> InspectorTabsRecord {
        guard seen.insert(key).inserted else { return record }
        var r = record
        r.selected = .pond
        return r
    }
}

public enum InspectorKeys {
    /// ⌘T while the keys are in the right zone (its terminal) makes a terminal tab there; anywhere else it stays a chat.
    public static func newTab(focusedZone: DockZone?) -> FocusAction {
        focusedZone == .right ? .newTerminal : .newThread
    }
}
