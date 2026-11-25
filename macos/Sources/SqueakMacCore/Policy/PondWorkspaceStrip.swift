/// The centre strip in the new layout. The roster owns duty and Duck order. The tab store owns opened items.
public struct PondWorkspaceStrip: Equatable, Sendable {
    public let row: DuckRowModel
    public let items: [TabItem]
    public let currentItem: TabItem?

    public init(roster: DuckRoster, place: DuckRowPlace, items: [TabItem], current: TabItem?) {
        currentItem = current
        row = DuckAvatarRow.build(roster: roster, place: current == nil ? place : .dashboard)
        self.items = items
    }

    public var isEmpty: Bool { row.isEmpty && items.isEmpty }

    /// Every tab of the one bar in order: on-duty Ducks first (never closable), then an Off-duty Duck whose chat is showing,
    /// then the opened items. `activity` is the open Duck's current step ("editing auth.ts"), which only that Duck knows.
    public func tabs(activity: String? = nil) -> [PondStripTab] {
        let ducks = row.ducks.map { duck in
            PondStripTab(
                item: .duck(duck.id), duck: duck, closable: !duck.onDuty,
                title: PondTabStatus.title(for: duck),
                status: PondTabStatus.fullLine(for: duck, activity: duck.id == row.selectedDuck ? activity : nil))
        }
        return ducks + items.map { PondStripTab(item: $0, duck: nil, closable: true, title: nil, status: nil) }
    }
    private var order: [TabItem] { row.ducks.filter(\.opensChat).map { .duck($0.id) } + items }
    private var selection: TabItem? { currentItem ?? row.selectedDuck.map(TabItem.duck) }

    public func target(at index: Int) -> TabItem? {
        let tabs = order
        return tabs.indices.contains(index) ? tabs[index] : nil
    }

    public func step(by delta: Int) -> TabItem? {
        let tabs = order
        guard !tabs.isEmpty else { return nil }
        guard let selection, let index = tabs.firstIndex(of: selection) else {
            return delta < 0 ? tabs.last : tabs.first
        }
        let offset = (index + delta % tabs.count + tabs.count) % tabs.count
        return tabs[offset]
    }
}

/// Which edges of the horizontal strip still have content past the viewport.
public struct PondStripOverflow: Equatable, Sendable {
    public let leading: Bool
    public let trailing: Bool

    public init(contentStart: Double, contentEnd: Double, viewport: Double) {
        leading = contentStart < -1
        trailing = contentEnd > viewport + 1
    }

    public var isOverflowing: Bool { leading || trailing }
}

/// One oval tab of the bar.
public struct PondStripTab: Equatable, Sendable, Identifiable {
    public var item: TabItem
    /// Set for a Duck's tab.
    public var duck: DuckRowAvatar?
    /// On-duty Ducks cannot be closed; Off-duty Ducks and items can.
    public var closable: Bool
    /// A Duck tab's first line: the chat's title (what the Duck is used for), else its name. Nil for an item.
    public var title: String?
    /// A Duck tab's second line, beside the glyph: "Pip \u{00B7} Working \u{00B7} editing auth.ts". Nil for an item.
    public var status: String?
    public var id: TabItem { item }
    /// The tab's full text, for its tooltip (labels may shorten, never wrap).
    public var help: String? { title.map { t in status.map { "\(t)\n\($0)" } ?? t } }
}

/// The one short line under a Duck's name on its tab, from the host's roster state.
public enum PondTabStatus {
    /// Line 1: the chat's title; a Duck with no title shows its name.
    public static func title(for duck: DuckRowAvatar) -> String {
        let title = (duck.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? duck.name : title
    }

    /// Line 2: the status, prefixed by the Duck's name while it wears one and the title is not already the name. An Off-duty
    /// Duck wears none: "Off duty".
    public static func fullLine(for duck: DuckRowAvatar, activity: String? = nil) -> String {
        let status = line(for: duck, activity: activity)
        let named = duck.wearsName && duck.onDuty && title(for: duck) != duck.name
        return named ? "\(duck.name) \u{00B7} \(status)" : status
    }

    public static func line(for duck: DuckRowAvatar, activity: String? = nil) -> String {
        switch duck.presence {
        case .waiting: return "Needs you"
        case .off: return "Off duty"
        case .working:
            if let step = clean(activity) { return "Working \u{00B7} \(step)" }
            return duck.presenceLine.hasPrefix("Working") ? duck.presenceLine : "Working"
        case .idle:
            let line = duck.presenceLine
            return line.hasSuffix(" ago") ? String(line.dropLast(4)) : line
        }
    }

    /// "Editing auth.ts\u{2026}" reads as "editing auth.ts": lower-cased first letter, no trailing ellipsis.
    static func clean(_ activity: String?) -> String? {
        var text = (activity ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix("\u{2026}") || text.hasSuffix("...") { text = String(text.dropLast(text.hasSuffix("...") ? 3 : 1)) }
        text = text.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty, text != "Starting" else { return nil }
        return text.prefix(1).lowercased() + text.dropFirst()
    }
}
