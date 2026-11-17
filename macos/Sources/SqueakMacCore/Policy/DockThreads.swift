import Foundation

/// Where chat threads sit when they are not in the centre strip. Session state, never saved. The centre is implicit:
/// a thread with no placement is a chat tab there. One thread is in exactly one place: moving it detaches it from
/// every other zone first, and a docked thread is hidden from the centre strip (`isDocked`).
public struct DockThreads: Equatable, Sendable {
    public private(set) var placed: [DockZone: [String]] = [:]
    public private(set) var selected: [DockZone: String] = [:]

    public init() {}

    public func zone(of key: String) -> DockZone {
        for z in [DockZone.right, .bottom] where placed[z]?.contains(key) == true { return z }
        return .centre
    }

    public func isDocked(_ key: String) -> Bool { zone(of: key) != .centre }
    public func threads(in zone: DockZone) -> [String] { zone == .centre ? [] : (placed[zone] ?? []) }
    public func has(in zone: DockZone) -> Bool { !threads(in: zone).isEmpty }

    private mutating func detach(_ key: String) {
        for z in [DockZone.right, .bottom] {
            guard var list = placed[z], let i = list.firstIndex(of: key) else { continue }
            list.remove(at: i)
            placed[z] = list.isEmpty ? nil : list
            if selected[z] == key { selected[z] = list.isEmpty ? nil : list[min(i, list.count - 1)] }
        }
    }

    /// Puts a thread in `zone`, before `before` (nil = at the end); the centre means "no placement".
    public mutating func move(_ key: String, to zone: DockZone, before: String? = nil) {
        let old = self.zone(of: key)
        let oldIndex = placed[old]?.firstIndex(of: key)
        detach(key)
        guard zone != .centre else { return }
        var list = placed[zone] ?? []
        if let before, before != key, let i = list.firstIndex(of: before) {
            list.insert(key, at: i)
        } else if before == key, old == zone, let oldIndex {
            list.insert(key, at: min(oldIndex, list.count))
        } else {
            list.append(key)
        }
        placed[zone] = list
        selected[zone] = key
    }

    public mutating func close(_ key: String) { detach(key) }

    public mutating func select(_ key: String) {
        let z = zone(of: key)
        if z != .centre { selected[z] = key }
    }

    public mutating func deselect(_ zone: DockZone) { selected[zone] = nil }

    /// Only the threads that still exist, in their places, each zone's selection kept valid, no thread twice.
    public func pruned(keeping live: Set<String>) -> DockThreads {
        var out = DockThreads()
        var seen = Set<String>()
        for z in [DockZone.right, .bottom] {
            let list = (placed[z] ?? []).filter { live.contains($0) && seen.insert($0).inserted }
            guard !list.isEmpty else { continue }
            out.placed[z] = list
            if let s = selected[z], list.contains(s) { out.selected[z] = s }
        }
        return out
    }
}
