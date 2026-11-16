import Foundation

/// Where each shell of one workspace folder sits. Like `DockFiles` this is session state, never saved in a workspace
/// layout (a shell belongs to one folder and to this run of the app). Unlike files a shell has no implicit zone, so
/// every live shell is placed: `sync` adds new ones to the home zone and drops the ones the registry no longer has.
/// The Terminal panel's place in the layout is only that home zone (`DockLayout.terminalHome`).
public struct DockTerminals: Equatable, Sendable {
    public private(set) var placed: [DockZone: [UUID]] = [:]
    public private(set) var selected: [DockZone: UUID] = [:]
    /// The shell selected last, so ⌘J still knows where the terminal is while its zone shows something else.
    public private(set) var last: UUID?

    public init() {}

    public func zone(of id: UUID) -> DockZone? {
        DockZone.allCases.first { placed[$0]?.contains(id) == true }
    }

    public func terminals(in zone: DockZone) -> [UUID] { placed[zone] ?? [] }

    /// Whether a zone holds shells (so a side zone shows even with no panels).
    public func has(in zone: DockZone) -> Bool { !terminals(in: zone).isEmpty }

    /// The shell a zone shows, if one is selected there (otherwise the zone's file or panel shows).
    public func shown(in zone: DockZone) -> UUID? { selected[zone] }

    public var isEmpty: Bool { placed.values.allSatisfy(\.isEmpty) }

    private mutating func detach(_ id: UUID) {
        for z in DockZone.allCases {
            guard var list = placed[z], let i = list.firstIndex(of: id) else { continue }
            list.remove(at: i)
            placed[z] = list.isEmpty ? nil : list
            if selected[z] == id { selected[z] = list.isEmpty ? nil : list[min(i, list.count - 1)] }
        }
        if last == id { last = nil }
    }

    /// Matches the registry: gone shells dropped (a zone's selection falls next, then previous), new ones appended to
    /// `home`. Existing placements are never touched.
    public mutating func sync(live: [UUID], home: DockZone) {
        let alive = Set(live)
        for id in DockZone.allCases.flatMap({ placed[$0] ?? [] }) where !alive.contains(id) { detach(id) }
        let known = Set(DockZone.allCases.flatMap { placed[$0] ?? [] })
        for id in live where !known.contains(id) {
            placed[home, default: []].append(id)
        }
    }

    /// Only the shells that are live, in their places, each zone's selection kept valid.
    public func pruned(keeping live: Set<UUID>) -> DockTerminals {
        var out = DockTerminals()
        for z in DockZone.allCases {
            var seen = Set<UUID>()
            let list = (placed[z] ?? []).filter { live.contains($0) && seen.insert($0).inserted }
            guard !list.isEmpty else { continue }
            out.placed[z] = list
            if let s = selected[z], list.contains(s) { out.selected[z] = s }
        }
        if let l = last, live.contains(l) { out.last = l }
        return out
    }

    /// Puts a shell in `zone`, before `before` (nil = at the end); within a zone this reorders. It becomes that zone's selection.
    public mutating func move(_ id: UUID, to zone: DockZone, before: UUID? = nil) {
        let old = self.zone(of: id)
        let oldIndex = old.flatMap { placed[$0]?.firstIndex(of: id) }
        detach(id)
        var list = placed[zone] ?? []
        if let before, before != id, let i = list.firstIndex(of: before) {
            list.insert(id, at: i)
        } else if before == id, old == zone, let oldIndex {
            list.insert(id, at: min(oldIndex, list.count))
        } else {
            list.append(id)
        }
        placed[zone] = list
        selected[zone] = id
        last = id
    }

    /// A new shell: at the end of `zone`, selected.
    public mutating func open(_ id: UUID, in zone: DockZone) { move(id, to: zone) }

    public mutating func select(_ id: UUID) {
        guard let z = zone(of: id) else { return }
        selected[z] = id
        last = id
    }

    /// A panel or file was selected in `zone`: it shows instead of the shell.
    public mutating func deselect(_ zone: DockZone) { selected[zone] = nil }

    /// The shell closed: gone from its zone, which falls to the next shell, else the previous, else its file or panel.
    public mutating func close(_ id: UUID) { detach(id) }

    /// The zone ⌘J works on: where the selected shell is, else where the last selected one is, else any shell's zone.
    public func toggleZone() -> DockZone? {
        for z in [DockZone.bottom, .right, .centre] where selected[z] != nil { return z }
        if let l = last, let z = zone(of: l) { return z }
        return DockZone.allCases.first { has(in: $0) }
    }
}

public extension DockLayout {
    /// Where a new shell opens: the zone the Terminal panel sits in, else the bottom (the panel is hidden).
    var terminalHome: DockZone { zone(of: .terminal) ?? .bottom }

    /// Like `isZoneVisible(_:files:)`, with shells: a side zone that holds only shells still shows.
    func isZoneVisible(_ zone: DockZone, files: DockFiles, terminals: DockTerminals, threads: DockThreads = DockThreads()) -> Bool {
        isZoneVisible(zone, files: files) || terminals.has(in: zone) || threads.has(in: zone)
    }
}

public extension DockBottomPlacement {
    static func of(_ layout: DockLayout, files: DockFiles, terminals: DockTerminals, threads: DockThreads = DockThreads()) -> DockBottomPlacement {
        guard layout.isZoneVisible(.bottom, files: files, terminals: terminals, threads: threads) else { return .none }
        let right = layout.isZoneVisible(.right, files: files, terminals: terminals, threads: threads) && !layout.right.collapsed
        return right ? .underRight : .underCentre
    }
}
