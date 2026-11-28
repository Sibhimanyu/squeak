import Foundation

/// The centre strip in the new layout. The roster owns which Ducks are open and their order. The tab store owns opened items.
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

    /// Every tab of the one bar in order: open Ducks first (never closable), then a Closed Duck whose chat is showing,
    /// then the opened items. `activity` is the open Duck's current step ("editing auth.ts"), which only that Duck knows.
    /// A Duckling's pill follows its parent Duck's tab (`ducklings` has the host's record of each, by tab); the other items follow all Ducks.
    public func tabs(activity: String? = nil, ducklings: [TabItem: Duckling] = [:], now: Date = Date()) -> [PondStripTab] {
        func pill(_ item: TabItem) -> PondStripTab {
            guard item.kind == .duckling else { return PondStripTab(item: item, duck: nil, closable: true, title: nil, status: nil) }
            let parent = item.parentDuck.flatMap { id in row.ducks.first { $0.id == id } }
            return PondStripTab(
                item: item, duck: nil, closable: true, title: PondDucklingTab.title(ducklings[item]),
                status: PondDucklingTab.status(parent: parent?.name, duckling: ducklings[item], now: now))
        }
        var out: [PondStripTab] = []
        for duck in row.ducks {
            out.append(PondStripTab(
                item: .duck(duck.id), duck: duck, closable: !duck.isOpen,
                title: PondTabStatus.title(for: duck),
                status: PondTabStatus.fullLine(for: duck, activity: duck.id == row.selectedDuck ? activity : nil)))
            out += items.filter { $0.kind == .duckling && $0.parentDuck == duck.id }.map(pill)
        }
        let placed = Set(out.map(\.item))
        let rest = items.filter { !placed.contains($0) }
        // A Duckling whose parent is not in the row follows the Ducks, before the other items.
        return out + (rest.filter { $0.kind == .duckling } + rest.filter { $0.kind != .duckling }).map(pill)
    }
    private var order: [TabItem] { tabs().compactMap { $0.duck.map { !$0.opensChat } == true ? nil : $0.item } }
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
    /// Open Ducks cannot be closed; Closed Ducks and items can.
    public var closable: Bool
    /// A Duck tab's first line: the chat's title (what the Duck is used for), else its name. Nil for an item.
    public var title: String?
    /// A Duck tab's second line, beside the glyph: "Pip \u{00B7} Working \u{00B7} editing auth.ts". Nil for an item.
    public var status: String?
    public var id: TabItem { item }
    public init(item: TabItem, duck: DuckRowAvatar?, closable: Bool, title: String?, status: String?) {
        self.item = item; self.duck = duck; self.closable = closable; self.title = title; self.status = status
    }
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

    /// Line 2: the status, prefixed by the Duck's name while it wears one and the title is not already the name. A Closed
    /// Duck wears none: "Closed".
    public static func fullLine(for duck: DuckRowAvatar, activity: String? = nil) -> String {
        let status = line(for: duck, activity: activity)
        let named = duck.wearsName && duck.isOpen && title(for: duck) != duck.name
        return named ? "\(duck.name) \u{00B7} \(status)" : status
    }

    public static func line(for duck: DuckRowAvatar, activity: String? = nil) -> String {
        switch duck.presence {
        case .waiting: return "Needs you"
        case .off: return "Closed"
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

/// What a Duckling's pill says, from the host's record of it.
public enum PondDucklingTab {
    /// Line 1: the Duckling's task title.
    public static func title(_ duckling: Duckling?) -> String {
        let title = (duckling?.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? "Duckling" : title
    }

    /// Line 2: "<parent> \u{00B7} Working \u{00B7} 38s" while it runs, "<parent> \u{00B7} Done" once it ends. The tab stays after it ends.
    public static func status(parent: String?, duckling: Duckling?, now: Date = Date()) -> String {
        let state: String
        switch duckling?.status {
        case .running?:
            state = ["Working", duckling?.elapsed(now: now)].compactMap { $0 }.joined(separator: " \u{00B7} ")
        case .failed?: state = "Failed"
        case .stopped?: state = "Stopped"
        case .unknown?: state = "Unknown"
        case .done?, nil: state = "Done"
        }
        return [parent, state].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
    }
}
