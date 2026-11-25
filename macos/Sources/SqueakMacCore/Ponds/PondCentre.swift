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
        /// The New duck page: its own state, with no Duck selected and no page selected.
        case newDuck
    }

    /// What Esc does next.
    public enum EscapeStep: Equatable, Sendable { case deselectItem, toParentDuck, toRoom, toDashboard, closeNewDuck, nothing }

    /// The pond page underneath everything: the one the switch last picked, remembered while a Duck or item covers it.
    public private(set) var page: PondPage
    /// The Duck whose chat is open, if any.
    public private(set) var duck: String?
    /// The selected item tab (a file, diff, Notebook...), over the page or the Duck.
    public private(set) var item: TabItem?
    /// The New duck page is open. It covers everything, and the Duck that was open before it is no longer selected.
    public private(set) var newDuck: Bool

    public init(page: PondPage = .dashboard, duck: String? = nil, item: TabItem? = nil, newDuck: Bool = false) {
        self.page = page; self.newDuck = newDuck
        // A page that is its own state leaves no Duck or item selected: the last one never leaks into it.
        self.duck = newDuck ? nil : duck; self.item = newDuck ? nil : item
    }

    public var shows: Shows {
        if newDuck { return .newDuck }
        if let item { return .item(item) }
        if let duck { return .duck(duck) }
        return .page(page)
    }

    /// The switch's selected segment: a page only when a page is what shows.
    public var switchSelection: PondPage? {
        if case .page(let p) = shows { return p }
        return nil
    }

    /// The Duck whose chat the centre shows, from the live state. `lastChat` is kept while a pond page covers the chat, so a
    /// selected Duck is on screen only when the location itself is that chat: a stale one would make clicking that same Duck
    /// a no-op (it already looks open) and would make a swipe a no-op (it looks like a Duck covers the pages).
    public static func liveDuck(selected: String?, location: WorkbenchLocation, selectedKey: SessionKey?) -> String? {
        guard let selected, let selectedKey, location.chatKey == selectedKey else { return nil }
        return selected
    }

    /// The page the Dashboard/Room strip must rest on whenever it is mounted: always the remembered page, never a copy.
    public var stripPage: PondPage { page }

    /// The tab row's selected tab.
    public var selectedTab: TabItem? {
        switch shows {
        case .item(let i): i
        case .duck(let d): .duck(d)
        case .page, .newDuck: nil
        }
    }

    /// The Duck subheader (its branch chip and the Duck gradient) belongs only to a selected Duck.
    public var showsDuckSubheader: Bool { if case .duck = shows { return true } else { return false } }

    /// The New duck page: over the page, with no Duck selected.
    public mutating func startNewDuck() { newDuck = true; duck = nil; item = nil }

    /// The switch: that page, leaving any Duck, item or the New duck page.
    public mutating func switchTo(_ target: PondPage) { page = target; duck = nil; item = nil; newDuck = false }

    /// A Duck's tab (or a deep link to it): its chat, over the remembered page.
    public mutating func selectDuck(_ id: String) { duck = id; item = nil; newDuck = false }

    /// An item tab: over whatever is underneath.
    public mutating func selectItem(_ tab: TabItem) {
        if tab.kind == .duck { selectDuck(tab.id) } else { item = tab; newDuck = false }
    }

    /// A deep link from a Room message: the Duck's chat; the Room stays the page the way back lands on.
    public mutating func deepLink(duck id: String) { selectDuck(id) }

    /// A two-finger swipe moves the page strip, which only shows while a page does.
    public mutating func swipe(to target: PondPage) {
        guard case .page = shows else { return }
        page = target
    }

    /// The pond menu (settings, invite, leave) sits at the bar's end on the Dashboard, the Room and items. Inside a Duck the
    /// subheader carries that Duck's own menu, so the bar shows none: never two menus stacked in one view.
    public var showsPondMenu: Bool { duck == nil }

    /// What to carry out to get from `old` (what was on screen) to this value (after an event): the one list the views apply,
    /// so the switch, the swipe, Esc and a deep link all change the screen the same way.
    public struct Effects: Equatable, Sendable {
        public var page: PondPage?
        public var deselectItem = false
        public var openDuck: String?
        public var leaveDuck = false
        public var openNewDuck = false
        public var closeNewDuck = false
        public var isEmpty: Bool { page == nil && !deselectItem && openDuck == nil && !leaveDuck && !openNewDuck && !closeNewDuck }
    }

    public func effects(from old: PondCentre) -> Effects {
        var e = Effects()
        if page != old.page { e.page = page }
        if old.item != nil, item == nil { e.deselectItem = true }
        if let duck, duck != old.duck { e.openDuck = duck }
        if old.duck != nil, duck == nil, !newDuck { e.leaveDuck = true }
        if newDuck, !old.newDuck { e.openNewDuck = true }
        if !newDuck, old.newDuck { e.closeNewDuck = true }
        return e
    }

    public var escapeStep: EscapeStep {
        switch shows {
        case .item(let tab): tab.kind == .duckling && tab.parentDuck != nil ? .toParentDuck : .deselectItem
        case .duck: .toRoom
        case .newDuck: .closeNewDuck
        case .page(.room): .toDashboard
        case .page(.dashboard): .nothing
        }
    }

    public mutating func escape() {
        switch escapeStep {
        case .deselectItem: item = nil
        // A Duckling's tab goes back to the Duck that started it, whatever chat is open underneath.
        case .toParentDuck: if let parent = item?.parentDuck { selectDuck(parent) }
        case .toRoom: switchTo(.room)
        case .toDashboard: switchTo(.dashboard)
        case .closeNewDuck: newDuck = false
        case .nothing: break
        }
    }
}
