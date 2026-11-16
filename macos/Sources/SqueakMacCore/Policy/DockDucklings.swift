import Foundation

/// Ducklings (a chat's background helpers) opened as tabs. They open in the centre strip, right after their parent
/// thread's tab (`CentreStripOrder`), and can be dragged to the right or bottom strip. Session state, never saved,
/// like docked threads. A duckling is in at most one place; opening one that is already open selects it. A side zone
/// remembers what it was showing, so closing the selected tab brings that back (`close` returns it); the centre has no
/// memory: closing there returns to the parent thread (the store selects it).
public struct DockDucklings: Equatable, Sendable {
    public private(set) var placed: [DockZone: [DucklingRef]] = [:]
    public private(set) var selected: [DockZone: DucklingRef] = [:]
    /// What each zone showed when its duckling was opened over it (a panel, file, thread or shell).
    public private(set) var returnTo: [DockZone: DockItem] = [:]

    public init() {}

    public func zone(of ref: DucklingRef) -> DockZone? {
        for z in DockZone.allCases where placed[z]?.contains(ref) == true { return z }
        return nil
    }

    public func isOpen(_ ref: DucklingRef) -> Bool { zone(of: ref) != nil }
    public func ducklings(in zone: DockZone) -> [DucklingRef] { placed[zone] ?? [] }
    public func has(in zone: DockZone) -> Bool { !ducklings(in: zone).isEmpty }

    @discardableResult
    private mutating func detach(_ ref: DucklingRef) -> DockZone? {
        var from: DockZone?
        for z in DockZone.allCases {
            guard var list = placed[z], let i = list.firstIndex(of: ref) else { continue }
            list.remove(at: i)
            placed[z] = list.isEmpty ? nil : list
            from = z
            if selected[z] == ref { selected[z] = list.isEmpty ? nil : list[min(i, list.count - 1)] }
            if list.isEmpty { returnTo[z] = nil }
        }
        return from
    }

    /// Opens a duckling in `zone` (the centre by default) and selects it; already open = just selected, wherever it is. `showing` is what the zone shows now, remembered for `close` unless a duckling already covers it.
    @discardableResult
    public mutating func open(_ ref: DucklingRef, in zone: DockZone = .centre, showing: DockItem? = nil) -> DockZone? {
        if let z = self.zone(of: ref) { selected[z] = ref; return z }
        if selected[zone] == nil, zone != .centre, let showing { returnTo[zone] = showing }
        placed[zone, default: []].append(ref)
        selected[zone] = ref
        return zone
    }

    public mutating func select(_ ref: DucklingRef, showing: DockItem? = nil) {
        guard let z = zone(of: ref) else { return }
        if selected[z] == nil, z != .centre, let showing { returnTo[z] = showing }
        selected[z] = ref
    }

    public mutating func deselect(_ zone: DockZone) { selected[zone] = nil }

    /// Closes the tab. When it was the one showing and no other duckling takes over, the item the zone showed before
    /// it is returned, for the store to select again.
    @discardableResult
    public mutating func close(_ ref: DucklingRef) -> DockItem? {
        guard let z = zone(of: ref) else { return nil }
        let wasShown = selected[z] == ref
        let back = returnTo[z]
        detach(ref)
        return wasShown && selected[z] == nil ? back : nil
    }

    /// Dragged between strips or within one. Returns false when nothing moved.
    @discardableResult
    public mutating func move(_ ref: DucklingRef, to zone: DockZone, before: DucklingRef? = nil) -> Bool {
        guard let old = self.zone(of: ref) else { return open(ref, in: zone) != nil }
        let oldIndex = placed[old]?.firstIndex(of: ref)
        let memory = returnTo[old]
        detach(ref)
        var list = placed[zone] ?? []
        if let before, before != ref, let i = list.firstIndex(of: before) {
            list.insert(ref, at: i)
        } else if before == ref, old == zone, let oldIndex {
            list.insert(ref, at: min(oldIndex, list.count))
        } else {
            list.append(ref)
        }
        placed[zone] = list
        selected[zone] = ref
        if returnTo[zone] == nil, zone != .centre, old != zone, let memory { returnTo[zone] = memory }
        return true
    }

    /// Only the ducklings whose chat still exists (a finished one stays, marked done by its chip), no duckling twice.
    public func pruned(keeping sessions: Set<SessionKey>) -> DockDucklings {
        var out = DockDucklings()
        var seen = Set<DucklingRef>()
        for z in DockZone.allCases {
            let list = (placed[z] ?? []).filter { sessions.contains($0.session) && seen.insert($0).inserted }
            guard !list.isEmpty else { continue }
            out.placed[z] = list
            if let s = selected[z], list.contains(s) { out.selected[z] = s }
            if let r = returnTo[z] { out.returnTo[z] = r }
        }
        return out
    }
}

/// The centre strip's order with ducklings in it: each duckling sits right after its parent thread's tab (several in
/// the order they were opened), wherever that tab is among files and the like; one whose parent has no tab in the
/// strip goes to the end.
public enum CentreStripOrder {
    public enum Entry<Item> {
        case item(Item)
        case duckling(DucklingRef)
    }

    /// `chatKey` names an item's thread (`SessionKey.stringValue`), nil for an item that is not a thread.
    public static func order<Item>(_ items: [Item], chatKey: (Item) -> String?, ducklings: [DucklingRef]) -> [Entry<Item>] {
        var byParent: [String: [DucklingRef]] = [:]
        for d in ducklings { byParent[d.session.stringValue, default: []].append(d) }
        var out: [Entry<Item>] = []
        for item in items {
            out.append(.item(item))
            if let k = chatKey(item) { out += (byParent.removeValue(forKey: k) ?? []).map { Entry.duckling($0) } }
        }
        for d in ducklings where byParent[d.session.stringValue]?.contains(d) == true { out.append(.duckling(d)) }
        return out
    }
}
