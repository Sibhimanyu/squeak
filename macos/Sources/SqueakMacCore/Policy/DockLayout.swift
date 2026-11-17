import Foundation

/// A panel the person can dock: the Thread, Pond, Code and Terminal views. Chats and files are not panels; they are always in the centre.
public enum DockPanel: String, Codable, CaseIterable, Sendable {
    case thread, pond, code, terminal

    public var title: String {
        switch self {
        case .thread: return "Thread"
        case .pond: return "Pond"
        case .code: return "Code"
        case .terminal: return "Terminal"
        }
    }

    public var symbol: String {
        switch self {
        case .thread: return "bubble.left"
        case .pond: return "person.2"
        case .code: return "chevron.left.forwardslash.chevron.right"
        case .terminal: return "terminal"
        }
    }

    /// Where a closed panel comes back to.
    public var home: DockZone { self == .terminal ? .bottom : .right }
}

/// The three places a panel can sit.
public enum DockZone: String, Codable, CaseIterable, Sendable { case centre, right, bottom }

/// One zone's tabs. In the centre chats and files are implicit and always present, so `selected == nil` there means a
/// chat or file is showing, not a panel.
public struct DockZoneState: Codable, Equatable, Sendable {
    public var panels: [DockPanel]
    public var selected: DockPanel?
    /// Width for the right zone, height for the bottom; ignored in the centre. nil = the default.
    public var size: Double?
    /// The bottom zone: only the tab strip shows. (For the right zone the UI reads it as closed but remembered.)
    public var collapsed: Bool

    public init(panels: [DockPanel] = [], selected: DockPanel? = nil, size: Double? = nil, collapsed: Bool = false) {
        self.panels = panels; self.selected = selected; self.size = size; self.collapsed = collapsed
    }

    private enum CodingKeys: String, CodingKey { case panels, selected, size, collapsed }

    /// Lenient: missing keys take defaults and a panel name from a future version is skipped.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = (try? c.decodeIfPresent([String].self, forKey: .panels)) ?? []
        panels = raw.compactMap(DockPanel.init(rawValue:))
        selected = ((try? c.decodeIfPresent(String.self, forKey: .selected)) ?? nil).flatMap(DockPanel.init(rawValue:))
        size = (try? c.decodeIfPresent(Double.self, forKey: .size)) ?? nil
        collapsed = (try? c.decodeIfPresent(Bool.self, forKey: .collapsed)) ?? false
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(panels, forKey: .panels)
        try c.encodeIfPresent(selected, forKey: .selected)
        try c.encodeIfPresent(size, forKey: .size)
        try c.encode(collapsed, forKey: .collapsed)
    }
}

/// Where every panel is: exactly one of the three zones or `hidden` (closed by the person). Every operation keeps that,
/// and keeps each zone's `selected` among its panels (or nil).
public struct DockLayout: Codable, Equatable, Sendable {
    public var centre: DockZoneState
    public var right: DockZoneState
    public var bottom: DockZoneState
    public var hidden: [DockPanel]
    /// The sidebar is part of the arrangement, so each workspace remembers it: folded or not, and its dragged width (nil = default).
    public var sidebarCollapsed: Bool
    public var sidebarWidth: Double?
    /// Closing the inspector folded the bottom zone (it sat under the inspector); opening it again unfolds it. Not saved.
    public var bottomFoldedWithInspector = false

    public init(centre: DockZoneState = .init(), right: DockZoneState = .init(), bottom: DockZoneState = .init(), hidden: [DockPanel] = [],
                sidebarCollapsed: Bool = false, sidebarWidth: Double? = nil) {
        self.centre = centre; self.right = right; self.bottom = bottom; self.hidden = hidden
        self.sidebarCollapsed = sidebarCollapsed; self.sidebarWidth = sidebarWidth
    }

    public static let rightSizeRange: ClosedRange<Double> = PaneWidths.inspectorRange
    public static let bottomSizeRange: ClosedRange<Double> = TerminalPanelSizing.minHeight...1600

    /// Today's layout: Thread, Pond and Code on the right (Thread selected), the Terminal collapsed at the bottom.
    public static let standard = DockLayout(
        right: DockZoneState(panels: [.thread, .pond, .code], selected: .thread),
        bottom: DockZoneState(panels: [.terminal], selected: .terminal, collapsed: true))

    /// The first layout, built from the old `@AppStorage` values.
    public static func migrated(codeView: Bool, terminalOpen: Bool, inspectorOpen: Bool, inspectorWidth: Double, terminalHeight: Double) -> DockLayout {
        var l = DockLayout.standard
        if codeView { l.right.selected = .code }
        l.right.collapsed = !inspectorOpen
        l.right.size = clampedSize(inspectorWidth, rightSizeRange)
        l.bottom.collapsed = !terminalOpen
        l.bottom.size = clampedSize(terminalHeight, bottomSizeRange)
        return l
    }

    private static func clampedSize(_ v: Double?, _ range: ClosedRange<Double>) -> Double? {
        guard let v, v.isFinite, v > 0 else { return nil }
        return min(max(v, range.lowerBound), range.upperBound)
    }

    // MARK: Reading

    public subscript(zone: DockZone) -> DockZoneState {
        get {
            switch zone {
            case .centre: return centre
            case .right: return right
            case .bottom: return bottom
            }
        }
        set {
            switch zone {
            case .centre: centre = newValue
            case .right: right = newValue
            case .bottom: bottom = newValue
            }
        }
    }

    /// The zone a panel sits in; nil when it is hidden.
    public func zone(of panel: DockPanel) -> DockZone? {
        DockZone.allCases.first { self[$0].panels.contains(panel) }
    }

    /// Right and bottom show only with panels; the centre always shows.
    public func isZoneVisible(_ zone: DockZone) -> Bool {
        zone == .centre || !self[zone].panels.isEmpty
    }

    // MARK: Operations

    /// Takes the panel out of wherever it is. A zone that loses its selected panel falls to the next one, else the previous.
    private mutating func detach(_ panel: DockPanel) {
        hidden.removeAll { $0 == panel }
        for z in DockZone.allCases {
            guard let i = self[z].panels.firstIndex(of: panel) else { continue }
            self[z].panels.remove(at: i)
            if self[z].selected == panel {
                let rest = self[z].panels
                self[z].selected = rest.isEmpty ? nil : rest[min(i, rest.count - 1)]
            }
        }
    }

    /// Moves a panel to `zone`, before `before` (nil = at the end); within a zone this reorders. It becomes that zone's selection.
    public mutating func move(_ panel: DockPanel, to zone: DockZone, before: DockPanel? = nil) {
        // The Pond tab is ambient awareness beside the work; managing a pond is the dashboard, which is a page, not a tab.
        guard !(panel == .pond && zone == .centre) else { return }
        let old = self.zone(of: panel)
        let oldIndex = old.flatMap { self[$0].panels.firstIndex(of: panel) }
        detach(panel)
        var panels = self[zone].panels
        if let before, before != panel, let i = panels.firstIndex(of: before) {
            panels.insert(panel, at: i)
        } else if before == panel, old == zone, let oldIndex {
            panels.insert(panel, at: min(oldIndex, panels.count))
        } else {
            panels.append(panel)
        }
        self[zone].panels = panels
        self[zone].selected = panel
        if zone != .centre { self[zone].collapsed = false }
    }

    /// Selects a visible panel (a hidden one is left alone; use `show`).
    public mutating func select(_ panel: DockPanel) {
        guard let z = zone(of: panel) else { return }
        self[z].selected = panel
    }

    /// The centre shows a chat or file again.
    public mutating func selectChats() { centre.selected = nil }

    /// Closes a panel: it goes to `hidden`.
    public mutating func close(_ panel: DockPanel) {
        detach(panel)
        hidden.append(panel)
    }

    /// Opens a panel: a hidden one returns to its home zone; either way it is selected and its zone uncollapsed.
    public mutating func show(_ panel: DockPanel) {
        if zone(of: panel) == nil {
            hidden.removeAll { $0 == panel }
            self[panel.home].panels.append(panel)
        }
        guard let z = zone(of: panel) else { return }
        self[z].selected = panel
        if z != .centre { self[z].collapsed = false }
    }

    /// Closes a panel that is showing, otherwise shows it (⌘J, ⌥⌘C).
    public mutating func toggle(_ panel: DockPanel) {
        if let z = zone(of: panel), self[z].selected == panel, z == .centre || !self[z].collapsed {
            close(panel)
        } else {
            show(panel)
        }
    }

    public mutating func setSize(_ size: Double?, for zone: DockZone) {
        guard zone != .centre else { return }
        self[zone].size = Self.clampedSize(size, zone == .right ? Self.rightSizeRange : Self.bottomSizeRange)
    }

    public mutating func setSidebarWidth(_ width: Double?) {
        sidebarWidth = Self.clampedSize(width, PaneWidths.sidebarRange)
    }

    public mutating func setCollapsed(_ collapsed: Bool, for zone: DockZone) {
        guard zone != .centre else { return }
        let wasCollapsed = self[zone].collapsed
        self[zone].collapsed = collapsed
        if zone == .right, collapsed != wasCollapsed {
            if collapsed {
                // The bottom zone sat under the inspector: it folds to its strip (its height is kept), full width.
                if !bottom.collapsed, !bottom.panels.isEmpty { bottom.collapsed = true; bottomFoldedWithInspector = true }
            } else if bottomFoldedWithInspector {
                bottom.collapsed = false; bottomFoldedWithInspector = false
            }
        } else if zone == .bottom, !collapsed {
            bottomFoldedWithInspector = false
        }
    }

    // MARK: Repair

    /// A repaired copy: duplicates dropped (first wins), missing panels hidden, bad selections and sizes fixed.
    public func normalized() -> DockLayout {
        var out = self
        var seen = Set<DockPanel>()
        for z in DockZone.allCases {
            var kept: [DockPanel] = []
            for p in out[z].panels where seen.insert(p).inserted { kept.append(p) }
            out[z].panels = kept
        }
        // The Pond panel never lives in the centre (an older save may have it there): it goes to the right zone.
        if let i = out.centre.panels.firstIndex(of: .pond) {
            out.centre.panels.remove(at: i)
            out.right.panels.append(.pond)
        }
        var hid: [DockPanel] = []
        for p in out.hidden where seen.insert(p).inserted { hid.append(p) }
        for p in DockPanel.allCases where seen.insert(p).inserted { hid.append(p) }
        out.hidden = hid
        for z in DockZone.allCases {
            let s = out[z]
            if let sel = s.selected, s.panels.contains(sel) {} else {
                out[z].selected = z == .centre ? nil : s.panels.first
            }
        }
        out.centre.size = nil
        out.centre.collapsed = false
        out.right.size = Self.clampedSize(out.right.size, Self.rightSizeRange)
        out.bottom.size = Self.clampedSize(out.bottom.size, Self.bottomSizeRange)
        out.sidebarWidth = Self.clampedSize(out.sidebarWidth, PaneWidths.sidebarRange)
        return out
    }

    private enum CodingKeys: String, CodingKey { case centre, right, bottom, hidden, sidebarCollapsed, sidebarWidth }

    /// Lenient, then repaired: a hand-edited, partial or newer layout never fails and never loses a panel.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        centre = (try? c.decodeIfPresent(DockZoneState.self, forKey: .centre)) ?? DockZoneState()
        right = (try? c.decodeIfPresent(DockZoneState.self, forKey: .right)) ?? DockZoneState()
        bottom = (try? c.decodeIfPresent(DockZoneState.self, forKey: .bottom)) ?? DockZoneState()
        let raw = (try? c.decodeIfPresent([String].self, forKey: .hidden)) ?? []
        hidden = raw.compactMap(DockPanel.init(rawValue:))
        sidebarCollapsed = (try? c.decodeIfPresent(Bool.self, forKey: .sidebarCollapsed)) ?? false
        sidebarWidth = (try? c.decodeIfPresent(Double.self, forKey: .sidebarWidth)) ?? nil
        gainThreadIfMissing()
        self = normalized()
    }

    /// A save from before the Thread tab: it joins the right zone in its default place (before Pond). A person who had
    /// not changed the old default (Pond and Code on the right, Pond showing, nothing else moved) also gets Thread
    /// showing, as a fresh install does; any other arrangement keeps its own selection.
    private mutating func gainThreadIfMissing() {
        guard zone(of: .thread) == nil, !hidden.contains(.thread) else { return }
        guard !right.panels.isEmpty else { hidden.append(.thread); return }
        let wasDefault = centre.panels.isEmpty && right.panels == [.pond, .code] && right.selected == .pond
        right.panels.insert(.thread, at: right.panels.firstIndex(of: .pond) ?? 0)
        if wasDefault { right.selected = .thread }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(centre, forKey: .centre)
        try c.encode(right, forKey: .right)
        try c.encode(bottom, forKey: .bottom)
        try c.encode(hidden, forKey: .hidden)
        try c.encode(sidebarCollapsed, forKey: .sidebarCollapsed)
        try c.encodeIfPresent(sidebarWidth, forKey: .sidebarWidth)
    }
}

/// A named arrangement: `saved` is what it was defined as, `current` is what the person has changed it to since.
public struct DockWorkspace: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var builtIn: Bool
    public var saved: DockLayout
    public var current: DockLayout

    public init(id: String, name: String, builtIn: Bool, saved: DockLayout, current: DockLayout? = nil) {
        self.id = id; self.name = name; self.builtIn = builtIn; self.saved = saved; self.current = current ?? saved
    }

    private enum CodingKeys: String, CodingKey { case id, name, builtIn, saved, current }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decode(String.self, forKey: .name)) ?? id
        builtIn = (try? c.decode(Bool.self, forKey: .builtIn)) ?? false
        saved = (try? c.decode(DockLayout.self, forKey: .saved)) ?? .standard
        current = (try? c.decode(DockLayout.self, forKey: .current)) ?? saved
    }
}

/// The store of workspaces and which one is active. The three built-ins are always there.
public struct DockWorkspaces: Codable, Equatable, Sendable {
    public static let defaultID = "default"

    public var workspaces: [DockWorkspace]
    public var activeID: String

    public var active: DockWorkspace {
        workspaces.first { $0.id == activeID } ?? workspaces[0]
    }

    /// The built-ins, as defined.
    public static let builtIns: [DockWorkspace] = [
        DockWorkspace(id: "default", name: "Default", builtIn: true, saved: .standard),
        DockWorkspace(id: "terminal", name: "Terminal focus", builtIn: true, saved: DockLayout(
            centre: DockZoneState(panels: [.terminal], selected: .terminal),
            right: DockZoneState(panels: [.thread, .pond, .code], selected: .thread))),
        DockWorkspace(id: "review", name: "Review", builtIn: true, saved: DockLayout(
            centre: DockZoneState(panels: [.code], selected: .code),
            right: DockZoneState(panels: [.thread, .pond], selected: .thread),
            bottom: DockZoneState(panels: [.terminal], selected: .terminal, collapsed: true))),
    ]

    public init(workspaces: [DockWorkspace] = DockWorkspaces.builtIns, activeID: String = DockWorkspaces.defaultID) {
        self.workspaces = workspaces; self.activeID = activeID
        self = normalized()
    }

    /// The built-ins, with Default's current layout being the one migrated from the old settings.
    public static func initial(migratedFrom layout: DockLayout) -> DockWorkspaces {
        var w = DockWorkspaces()
        w.workspaces[0].current = layout.normalized()
        return w
    }

    // MARK: Operations

    private func index(_ id: String) -> Int? { workspaces.firstIndex { $0.id == id } }

    /// Records the person's change to the active workspace.
    public mutating func update(_ layout: DockLayout) {
        guard let i = index(activeID) else { return }
        workspaces[i].current = layout.normalized()
    }

    public mutating func switchTo(id: String) {
        if index(id) != nil { activeID = id }
    }

    /// A name no other workspace has: "Name", then "Name 2", "Name 3".
    private func uniqueName(_ name: String, excluding id: String? = nil) -> String {
        let taken = Set(workspaces.filter { $0.id != id }.map(\.name))
        guard taken.contains(name) else { return name }
        var n = 2
        while taken.contains("\(name) \(n)") { n += 1 }
        return "\(name) \(n)"
    }

    /// Saves the active workspace's current layout as a new workspace and switches to it. nil for an empty name.
    @discardableResult
    public mutating func saveNew(name: String) -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let layout = active.current
        let id = "custom-" + UUID().uuidString.lowercased()
        workspaces.append(DockWorkspace(id: id, name: uniqueName(trimmed), builtIn: false, saved: layout, current: layout))
        activeID = id
        return id
    }

    /// Puts the active workspace back as it was saved.
    public mutating func resetActive() {
        guard let i = index(activeID) else { return }
        workspaces[i].current = workspaces[i].saved
    }

    /// Built-ins stay. Deleting the active one switches to Default.
    public mutating func delete(id: String) {
        guard let i = index(id), !workspaces[i].builtIn else { return }
        workspaces.remove(at: i)
        if activeID == id { activeID = Self.defaultID }
    }

    public mutating func rename(id: String, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let i = index(id), !workspaces[i].builtIn, !trimmed.isEmpty else { return }
        workspaces[i].name = uniqueName(trimmed, excluding: id)
    }

    /// Makes the current layout the saved one (custom workspaces only).
    public mutating func overwriteActive() {
        guard let i = index(activeID), !workspaces[i].builtIn else { return }
        workspaces[i].saved = workspaces[i].current
    }

    // MARK: Repair

    /// Built-ins always present (keeping the person's `current`), custom ones deduplicated, a bad `activeID` becomes Default.
    public func normalized() -> DockWorkspaces {
        var out: [DockWorkspace] = []
        for b in Self.builtIns {
            var w = b
            if let have = workspaces.first(where: { $0.id == b.id }) { w.current = have.current.normalized() }
            out.append(w)
        }
        var ids = Set(out.map(\.id))
        for w in workspaces where !ids.contains(w.id) {
            ids.insert(w.id)
            var c = w
            c.builtIn = false
            c.saved = w.saved.normalized()
            c.current = w.current.normalized()
            out.append(c)
        }
        var result = DockWorkspaces(unchecked: out, activeID: activeID)
        if !ids.contains(result.activeID) { result.activeID = Self.defaultID }
        return result
    }

    private init(unchecked workspaces: [DockWorkspace], activeID: String) {
        self.workspaces = workspaces; self.activeID = activeID
    }

    private enum CodingKeys: String, CodingKey { case workspaces, activeID }

    private struct Lossy: Decodable {
        let value: DockWorkspace?
        init(from decoder: Decoder) throws { value = try? DockWorkspace(from: decoder) }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let list = ((try? c.decodeIfPresent([Lossy].self, forKey: .workspaces)) ?? []).compactMap(\.value)
        let id = (try? c.decodeIfPresent(String.self, forKey: .activeID)) ?? Self.defaultID
        self = DockWorkspaces(unchecked: list, activeID: id).normalized()
    }
}
