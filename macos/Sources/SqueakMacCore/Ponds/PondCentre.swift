import Foundation

/// What a pond's centre shows: one value that the Dashboard | Room switch, the tabs, the swipe, Esc and a deep link all read
/// and write, so none of them can disagree with the page drawn below (the 2.34.6 bug: the switch said Room while the page was
/// the Dashboard, because the strip's own copy of the page went stale while the pond page was not mounted).
/// Pure: the views build it from live state, apply one event and carry out the difference.
public struct PondCentre: Equatable, Sendable {
    public enum Shows: Equatable, Sendable {
        case page(PondPage)
        case duck(String)
        case item(TabItem)
    }

    /// What Esc does next.
    public enum EscapeStep: Equatable, Sendable { case deselectItem, toRoom, toDashboard, nothing }

    /// The pond page underneath everything: the one the switch last picked, remembered while a Duck or item covers it.
    public private(set) var page: PondPage
    /// The Duck whose chat is open, if any.
    public private(set) var duck: String?
    /// The selected item tab (a file, diff, Notebook...), over the page or the Duck.
    public private(set) var item: TabItem?

    public init(page: PondPage = .dashboard, duck: String? = nil, item: TabItem? = nil) {
        self.page = page; self.duck = duck; self.item = item
    }

    public var shows: Shows {
        if let item { return .item(item) }
        if let duck { return .duck(duck) }
        return .page(page)
    }

    /// The switch's selected segment: a page only when a page is what shows.
    public var switchSelection: PondPage? {
        if case .page(let p) = shows { return p }
        return nil
    }

    /// The page the Dashboard/Room strip must rest on whenever it is mounted: always the remembered page, never a copy.
    public var stripPage: PondPage { page }

    /// The tab row's selected tab.
    public var selectedTab: TabItem? {
        switch shows {
        case .item(let i): i
        case .duck(let d): .duck(d)
        case .page: nil
        }
    }

    /// The switch: that page, leaving any Duck or item.
    public mutating func switchTo(_ target: PondPage) { page = target; duck = nil; item = nil }

    /// A Duck's tab (or a deep link to it): its chat, over the remembered page.
    public mutating func selectDuck(_ id: String) { duck = id; item = nil }

    /// An item tab: over whatever is underneath.
    public mutating func selectItem(_ tab: TabItem) {
        if tab.kind == .duck { selectDuck(tab.id) } else { item = tab }
    }

    /// A deep link from a Room message: the Duck's chat; the Room stays the page the way back lands on.
    public mutating func deepLink(duck id: String) { selectDuck(id) }

    /// A two-finger swipe moves the page strip, which only shows while a page does.
    public mutating func swipe(to target: PondPage) {
        guard case .page = shows else { return }
        page = target
    }

    public var escapeStep: EscapeStep {
        switch shows {
        case .item: .deselectItem
        case .duck: .toRoom
        case .page(.room): .toDashboard
        case .page(.dashboard): .nothing
        }
    }

    public mutating func escape() {
        switch escapeStep {
        case .deselectItem: item = nil
        case .toRoom: switchTo(.room)
        case .toDashboard: switchTo(.dashboard)
        case .nothing: break
        }
    }
}
