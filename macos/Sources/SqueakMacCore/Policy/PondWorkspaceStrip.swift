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
