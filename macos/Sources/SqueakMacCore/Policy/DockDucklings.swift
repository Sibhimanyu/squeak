import Foundation

/// Ducklings (a chat's background helpers) opened as tabs in the right or bottom strip. Session state, never saved,
/// like docked threads. A duckling is in at most one place; opening one that is already open selects it. A duckling
/// has no centre: moving it there closes it. Opening remembers what the zone was showing, so closing the selected tab
/// brings that back (`close` returns it).
public struct DockDucklings: Equatable, Sendable {
    public private(set) var placed: [DockZone: [DucklingRef]] = [:]
    public private(set) var selected: [DockZone: DucklingRef] = [:]
    /// What each zone showed when its duckling was opened over it (a panel, file, thread or shell).
    public private(set) var returnTo: [DockZone: DockItem] = [:]

    public init() {}

    public func zone(of ref: DucklingRef) -> DockZone? {
        for z in [DockZone.right, .bottom] where placed[z]?.contains(ref) == true { return z }
        return nil
    }

    public func isOpen(_ ref: DucklingRef) -> Bool { zone(of: ref) != nil }
    public func ducklings(in zone: DockZone) -> [DucklingRef] { zone == .centre ? [] : (placed[zone] ?? []) }
    public func has(in zone: DockZone) -> Bool { !ducklings(in: zone).isEmpty }

    @discardableResult
    private mutating func detach(_ ref: DucklingRef) -> DockZone? {
        var from: DockZone?
        for z in [DockZone.right, .bottom] {
            guard var list = placed[z], let i = list.firstIndex(of: ref) else { continue }
            list.remove(at: i)
            placed[z] = list.isEmpty ? nil : list
            from = z
            if selected[z] == ref { selected[z] = list.isEmpty ? nil : list[min(i, list.count - 1)] }
            if list.isEmpty { returnTo[z] = nil }
        }
        return from
    }

    /// Opens a duckling in `zone` (a side zone; the centre is refused) and selects it; already open = just selected,
    /// wherever it is. `showing` is what the zone shows now, remembered for `close` unless a duckling already covers it.
    @discardableResult
    public mutating func open(_ ref: DucklingRef, in zone: DockZone = .right, showing: DockItem? = nil) -> DockZone? {
        if let z = self.zone(of: ref) { selected[z] = ref; return z }
        guard zone != .centre else { return nil }
        if selected[zone] == nil, let showing { returnTo[zone] = showing }
        placed[zone, default: []].append(ref)
        selected[zone] = ref
        return zone
    }

    public mutating func select(_ ref: DucklingRef, showing: DockItem? = nil) {
        guard let z = zone(of: ref) else { return }
        if selected[z] == nil, let showing { returnTo[z] = showing }
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

    /// Dragged between strips or within one. The centre closes it. Returns false when nothing moved.
    @discardableResult
    public mutating func move(_ ref: DucklingRef, to zone: DockZone, before: DucklingRef? = nil) -> Bool {
        guard zone != .centre else { let was = isOpen(ref); close(ref); return was }
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
        if returnTo[zone] == nil, old != zone, let memory { returnTo[zone] = memory }
        return true
    }

    /// Only the ducklings whose chat still exists (a finished one stays, marked done by its chip), no duckling twice.
    public func pruned(keeping sessions: Set<SessionKey>) -> DockDucklings {
        var out = DockDucklings()
        var seen = Set<DucklingRef>()
        for z in [DockZone.right, .bottom] {
            let list = (placed[z] ?? []).filter { sessions.contains($0.session) && seen.insert($0).inserted }
            guard !list.isEmpty else { continue }
            out.placed[z] = list
            if let s = selected[z], list.contains(s) { out.selected[z] = s }
            if let r = returnTo[z] { out.returnTo[z] = r }
        }
        return out
    }
}
