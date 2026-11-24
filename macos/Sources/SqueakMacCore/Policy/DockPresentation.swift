import Foundation
import Observation

/// Where the bottom zone is drawn: under the right column when that column is showing (where the terminal has always
/// been), else under the centre. Nothing when it has no panels.
public enum DockBottomPlacement: Equatable, Sendable {
    case none, underRight, underCentre

    public static func of(_ layout: DockLayout) -> DockBottomPlacement {
        guard layout.isZoneVisible(.bottom) else { return .none }
        return layout.isZoneVisible(.right) && !layout.right.collapsed ? .underRight : .underCentre
    }
}

public extension DockZone {
    var title: String {
        switch self {
        case .centre: return "Centre"
        case .right: return "Right"
        case .bottom: return "Bottom"
        }
    }
}

/// What a tab strip's "+" does.
public enum DockPlusAction: Equatable, Sendable {
    case newChat
    case newTerminal
    /// A menu of the hidden panels, each shown in this zone.
    case showHidden([DockPanel])
    case none

    public static func of(zone: DockZone, layout: DockLayout, terminals: DockTerminals = DockTerminals()) -> DockPlusAction {
        if terminals.shown(in: zone) != nil { return .newTerminal }
        if zone == .centre, layout.centre.selected == nil { return .newChat }
        if layout[zone].selected == .terminal { return .newTerminal }
        if zone == .centre { return .newChat }
        return layout.hidden.isEmpty ? .none : .showHidden(layout.hidden)
    }
}

/// A dragged panel on the pasteboard: a prefixed string, so a chat tab's plain-string drag is never taken for one.
public enum DockPanelPayload {
    public static let prefix = "squeak-dock-panel:"
    public static func encode(_ panel: DockPanel) -> String { prefix + panel.rawValue }
    public static func decode(_ text: String) -> DockPanel? {
        guard text.hasPrefix(prefix) else { return nil }
        return DockPanel(rawValue: String(text.dropFirst(prefix.count)))
    }
}

public extension DockLayout {
    /// ⌥⌘B: the right zone away (remembered) or back; with no panels there, one is brought in.
    mutating func toggleRight() {
        if right.panels.isEmpty {
            if let p = hidden.first(where: { $0.home == .right }) { show(p) } else { move(.pond, to: .right) }
        } else {
            setCollapsed(!right.collapsed, for: .right)
        }
    }

    /// The terminal ended its last shell: a bottom zone folds to its strip, anywhere else the panel closes.
    mutating func dismiss(_ panel: DockPanel) {
        if let z = zone(of: panel), z == .bottom { setCollapsed(true, for: .bottom) } else { close(panel) }
    }

    /// Zen mode: the right and bottom zones fold away (their panels and the centre stay).
    func zen() -> DockLayout {
        var l = self
        l.setCollapsed(true, for: .right)
        l.setCollapsed(true, for: .bottom)
        l.sidebarCollapsed = true
        return l
    }

    /// Whether the panel is on screen: in the centre and selected, or selected in an uncollapsed side zone.
    func isShowing(_ panel: DockPanel) -> Bool {
        guard let z = zone(of: panel), self[z].selected == panel else { return false }
        return z == .centre || !self[z].collapsed
    }
}

/// The saved workspaces, observed by the window. Every change goes through `update`, then is written as JSON.
@MainActor @Observable
public final class DockStore {
    public static let defaultsKey = "dockWorkspaces"
    static let sidebarMigratedKey = "dockSidebarMigrated"
    public static let shared = DockStore()

    public private(set) var workspaces: DockWorkspaces
    /// Open files placed outside the centre (session state, never saved).
    public private(set) var files: DockFiles {
        get { filesByWorkspace.current }
        set { filesByWorkspace.current = newValue }
    }
    private var filesByWorkspace = WorkspaceKeyed<DockFiles>(fallback: DockFiles())
    /// Chat threads docked outside the centre (session state, never saved).
    public private(set) var threads: DockThreads {
        get { threadsByWorkspace.current }
        set { threadsByWorkspace.current = newValue }
    }
    private var threadsByWorkspace = WorkspaceKeyed<DockThreads>(fallback: DockThreads())
    /// Ducklings opened as tabs in a side zone (session state, never saved).
    public var ducklings: DockDucklings { ducklingsByWorkspace.current }
    private var ducklingsByWorkspace = WorkspaceKeyed<DockDucklings>(fallback: DockDucklings())
    /// The chat's workspace (`SidebarTreeBuilder.workspaceKey`), set by the window; centre and duckling selections are
    /// remembered per workspace, so coming back finds the subagent or panel that was open.
    public var activeWorkspace: String? { ducklingsByWorkspace.active }
    /// Maps a chat to its workspace id. Set by the app once; not observed.
    @ObservationIgnored public var workspaceOf: ((SessionKey) -> String?)?
    private var centrePanels = WorkspaceKeyed<DockPanel?>(fallback: nil)
    /// Shells placed in zones, per workspace folder (session state, never saved). `activeFolder` is the chat's folder.
    public private(set) var terminals: [String: DockTerminals] = [:]
    public private(set) var activeFolder: String?
    /// The current folder's shells.
    public var activeTerminals: DockTerminals { activeFolder.flatMap { terminals[$0] } ?? DockTerminals() }
    /// A panel being dragged right now (not saved): zones that could take it show their drop strips.
    public var dragging: DockItem?
    /// An artifact tab being dragged along the centre strip (not saved); cleared with `dragging`.
    public var draggingArtifact: StreamTab?
    /// The panel tab under the pointer (not observed): a drag that starts there is a panel drag.
    @ObservationIgnored public var hoveredTab: DockItem?
    /// Set by the window: a Pond panel dropped on the centre opens the pond dashboard instead of docking.
    @ObservationIgnored public var openPondDashboard: (() -> Void)?
    @ObservationIgnored private let defaults: UserDefaults

    public var layout: DockLayout { workspaces.active.current }

    /// First load builds Default from the old `@AppStorage` values and leaves those keys where they are.
    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.defaultsKey), let saved = try? JSONDecoder().decode(DockWorkspaces.self, from: data) {
            workspaces = saved
            // The sidebar joined the layout later: carry the old global choice into every workspace once.
            if !defaults.bool(forKey: Self.sidebarMigratedKey) {
                defaults.set(true, forKey: Self.sidebarMigratedKey)
                let collapsed = defaults.bool(forKey: "sidebarCollapsed")
                let width = defaults.object(forKey: "sidebarWidth") != nil ? defaults.double(forKey: "sidebarWidth") : nil
                for i in workspaces.workspaces.indices {
                    for keyPath in [\DockWorkspace.current, \DockWorkspace.saved] {
                        workspaces.workspaces[i][keyPath: keyPath].sidebarCollapsed = collapsed
                        workspaces.workspaces[i][keyPath: keyPath].setSidebarWidth(width)
                    }
                }
                save()
            }
        } else {
            let layout = DockLayout.migrated(
                codeView: defaults.bool(forKey: "inspectorCodeView"), terminalOpen: defaults.bool(forKey: "terminalOpen"),
                inspectorOpen: defaults.bool(forKey: "inspectorOpen"), inspectorWidth: defaults.double(forKey: "inspectorWidth"),
                terminalHeight: defaults.double(forKey: "terminalPanelHeight"))
            var l = layout
            l.sidebarCollapsed = defaults.bool(forKey: "sidebarCollapsed")
            if defaults.object(forKey: "sidebarWidth") != nil { l.setSidebarWidth(defaults.double(forKey: "sidebarWidth")) }
            defaults.set(true, forKey: Self.sidebarMigratedKey)
            workspaces = .initial(migratedFrom: l)
        }
    }

    private func save() {
        if let data = try? JSONEncoder().encode(workspaces) { defaults.set(data, forKey: Self.defaultsKey) }
    }

    /// Changes the active workspace's layout.
    public func update(_ change: (inout DockLayout) -> Void) {
        var l = layout
        change(&l)
        let before = layout
        guard l.normalized() != before else { return }
        workspaces.update(l)
        save()
        // A panel newly selected in a zone shows instead of that zone's file.
        for z in [DockZone.right, .bottom] where before[z].selected != layout[z].selected { files.deselect(z); threads.deselect(z); ducklingsByWorkspace.current.deselect(z); deselectTerminals(z) }
    }

    // MARK: Shells

    private func mutateTerminals(_ folder: String, _ change: (inout DockTerminals) -> Void) {
        var t = terminals[folder] ?? DockTerminals()
        change(&t)
        if t.isEmpty { if terminals[folder] != nil { terminals[folder] = nil } } else if terminals[folder] != t { terminals[folder] = t }
    }

    /// Mirrors the registry's shells for a folder: gone ones dropped, new ones placed in the home zone.
    public func syncTerminals(folder: String, live: [UUID]) {
        activeFolder = folder
        let home = layout.terminalHome
        let layout = self.layout
        mutateTerminals(folder) { t in
            t.sync(live: live, home: home)
            // A zone whose Terminal panel is its tab shows a shell: its first, until one is picked.
            for z in DockZone.allCases where layout[z].selected == .terminal && t.shown(in: z) == nil {
                if let first = t.terminals(in: z).first { t.select(first) }
            }
        }
    }

    /// A panel or file was selected in `zone` (or the chat in the centre): it shows instead of the zone's shell.
    public func deselectTerminals(_ zone: DockZone) {
        guard let f = activeFolder else { return }
        mutateTerminals(f) { $0.deselect(zone) }
    }

    /// A new shell opens in `zone` (nil = the home zone) and is selected; a folded side zone unfolds.
    public func openTerminal(_ id: UUID, folder: String, live: [UUID], in zone: DockZone? = nil) {
        activeFolder = folder
        let z = zone ?? layout.terminalHome
        let home = layout.terminalHome
        mutateTerminals(folder) { $0.sync(live: live, home: home); $0.open(id, in: z) }
        files.deselect(z); ducklingsByWorkspace.current.deselect(z)
        revealZone(z)
    }

    public func moveTerminal(_ id: UUID, to zone: DockZone, before: UUID? = nil) {
        guard let f = activeFolder else { return }
        mutateTerminals(f) { $0.move(id, to: zone, before: before) }
        files.deselect(zone); ducklingsByWorkspace.current.deselect(zone)
        revealZone(zone)
    }

    public func selectTerminal(_ id: UUID) {
        guard let f = activeFolder, let z = terminals[f]?.zone(of: id) else { return }
        mutateTerminals(f) { $0.select(id) }
        files.deselect(z); ducklingsByWorkspace.current.deselect(z)
        revealZone(z)
    }

    /// The shell closed (its process is ended by the host).
    public func closeTerminal(_ id: UUID) {
        guard let f = activeFolder else { return }
        mutateTerminals(f) { $0.close(id) }
    }

    private func revealZone(_ zone: DockZone) {
        if zone == .centre { update { $0.selectChats() } } else { update { $0.setCollapsed(false, for: zone) } }
    }

    /// Whether a shell is on screen: selected in the centre, or selected in an unfolded side zone.
    public var isTerminalShowing: Bool {
        let t = activeTerminals
        return DockZone.allCases.contains { z in
            t.shown(in: z) != nil && (z == .centre || !layout[z].collapsed) && (z != .centre || layout.centre.selected == nil)
        }
    }

    /// ⌘J: folds or unfolds the zone that holds the selected or last shell; with no shell, `needsShell` is true and the
    /// caller opens one in the home zone.
    public func toggleTerminalZone() -> Bool {
        guard let f = activeFolder, let z = terminals[f]?.toggleZone() else { return true }
        if z == .centre {
            if isTerminalShowing { update { $0.selectChats() }; deselectTerminals(.centre) } else {
                if let last = terminals[f]?.last ?? terminals[f]?.terminals(in: .centre).first { selectTerminal(last) }
            }
            return false
        }
        if terminals[f]?.shown(in: z) != nil && !layout[z].collapsed {
            update { $0.setCollapsed(true, for: z) }
        } else {
            if terminals[f]?.shown(in: z) == nil, let id = terminals[f]?.last ?? terminals[f]?.terminals(in: z).first { selectTerminal(id) }
            update { $0.setCollapsed(false, for: z) }
        }
        return false
    }

    /// Puts an open file in a zone (the centre = back to the strip); a folded side zone opens for it.
    public func moveFile(_ path: String, to zone: DockZone, before: String? = nil) {
        files.move(path, to: zone, before: before)
        deselectTerminals(zone); threads.deselect(zone); ducklingsByWorkspace.current.deselect(zone)
        if zone == .centre { update { $0.selectChats() } } else { update { $0.setCollapsed(false, for: zone) } }
    }

    /// A panel tab was pressed in a zone: it shows over that zone's file.
    public func selectPanel(_ panel: DockPanel, in zone: DockZone) {
        files.deselect(zone)
        deselectTerminals(zone); ducklingsByWorkspace.current.deselect(zone)
        update { $0.select(panel); $0.setCollapsed(false, for: zone) }
    }

    public func selectFile(_ path: String) {
        files.select(path)
        let z = files.zone(of: path)
        deselectTerminals(z); threads.deselect(z); ducklingsByWorkspace.current.deselect(z)
        if z != .centre { update { $0.setCollapsed(false, for: z) } }
    }

    /// Drops the placements of files that are no longer open.
    public func pruneFiles(keeping open: Set<String>) {
        let p = files.pruned(keeping: open)
        if p != files { files = p }
    }

    /// Docks a thread in a zone (the centre = back to the strip); a folded side zone opens for it.
    public func moveThread(_ key: String, to zone: DockZone, before: String? = nil) {
        threads.move(key, to: zone, before: before)
        files.deselect(zone); ducklingsByWorkspace.current.deselect(zone)
        deselectTerminals(zone)
        if zone == .centre { update { $0.selectChats() } } else { update { $0.setCollapsed(false, for: zone) } }
    }

    public func selectThread(_ key: String) {
        threads.select(key)
        let z = threads.zone(of: key)
        guard z != .centre else { return }
        files.deselect(z); ducklingsByWorkspace.current.deselect(z)
        deselectTerminals(z)
        update { $0.setCollapsed(false, for: z) }
    }

    public func closeThread(_ key: String) { threads.close(key) }

    public func pruneThreads(keeping live: Set<String>) {
        let p = threads.pruned(keeping: live)
        if p != threads { threads = p }
    }

    // MARK: Ducklings

    /// What a side zone shows right now, so closing a duckling's tab can bring it back.
    private func shownItem(in zone: DockZone) -> DockItem? {
        if let c = ducklings.selected[zone] { return .duckling(c) }
        if let t = activeTerminals.shown(in: zone) { return .terminal(t) }
        if let k = threads.selected[zone] { return .thread(k) }
        if let f = files.selected[zone] { return .file(f) }
        return layout[zone].selected.map { .panel($0) }
    }

    private func deselectOthers(for ref: DucklingRef, in zone: DockZone) {
        files.deselect(zone); threads.deselect(zone); deselectTerminals(zone)
        if zone == .centre { update { $0.selectChats() } } else { update { $0.setCollapsed(false, for: zone) } }
    }

    /// The centre's duckling tab stops being the shown one (a chat, file, panel or shell tab was picked).
    public func deselectDucklings(_ zone: DockZone) { ducklingsByWorkspace.current.deselect(zone) }

    /// Opens a duckling as a tab in `zone` (default: the centre, after its parent thread) and shows it; already open =
    /// selected where it is.
    public func openDuckling(_ ref: DucklingRef, in zone: DockZone = .centre) {
        let showing = ducklings.zone(of: ref).map { shownItem(in: $0) } ?? shownItem(in: zone)
        let z = ducklingsByWorkspace.current.open(ref, in: zone, showing: showing) ?? zone
        deselectOthers(for: ref, in: z)
    }

    public func selectDuckling(_ ref: DucklingRef) { openDuckling(ref) }

    /// Closes the tab; the zone goes back to what it showed before.
    public func closeDuckling(_ ref: DucklingRef) {
        guard let back = ducklingsByWorkspace.current.close(ref) else { return }
        switch back {
        case .panel(let p): update { $0.select(p) }
        case .file(let path): files.select(path)
        case .thread(let k): threads.select(k)
        case .terminal(let id): if let f = activeFolder { mutateTerminals(f) { $0.select(id) } }
        case .duckling: break
        }
    }

    public func moveDuckling(_ ref: DucklingRef, to zone: DockZone, before: DucklingRef? = nil) {
        ducklingsByWorkspace.current.move(ref, to: zone, before: before)
        deselectOthers(for: ref, in: zone)
    }

    /// A duckling belongs to its chat: only that chat's stay.
    public func pruneDucklings(keeping sessions: Set<SessionKey>) {
        var p = ducklingsByWorkspace
        p.transformAll { $0.pruned(keeping: sessions) }
        if p != ducklingsByWorkspace { ducklingsByWorkspace = p }
    }

    /// Makes `workspace` the one whose selections are read. The outgoing centre panel is remembered and the incoming
    /// one's brought back (a workspace not seen yet shows its chats).
    public func switchWorkspace(_ workspace: String?) {
        guard workspace != ducklingsByWorkspace.active else { return }
        let leaving = layout.centre.selected
        centrePanels.current = leaving
        ducklingsByWorkspace.switchTo(workspace)
        filesByWorkspace.switchTo(workspace)
        threadsByWorkspace.switchTo(workspace)
        centrePanels.switchTo(workspace)
        guard workspace != nil else { return }
        if let back = centrePanels.stored(workspace!) ?? nil {
            if layout.centre.selected != back, layout.zone(of: back) == .centre { update { $0.select(back) } }
        } else if layout.centre.selected != nil { update { $0.selectChats() } }
    }

    /// Forgets workspaces that no longer exist.
    public func pruneWorkspaces(keeping existing: Set<String>) {
        ducklingsByWorkspace.prune(keeping: existing)
        filesByWorkspace.prune(keeping: existing)
        threadsByWorkspace.prune(keeping: existing)
        centrePanels.prune(keeping: existing)
    }

    /// A side strip shows only the open chat's ducklings; the centre keeps its own after their parent's tab.
    public func pruneSideDucklings(keeping selected: SessionKey?) {
        if let selected, let w = workspaceOf?(selected) { switchWorkspace(w) }
        for z in [DockZone.right, .bottom] { for r in ducklings.ducklings(in: z) where r.session != selected { closeDuckling(r) } }
    }

    /// Changes the workspaces themselves (switch, save, reset, ...).
    public func edit(_ change: (inout DockWorkspaces) -> Void) {
        var w = workspaces
        change(&w)
        guard w != workspaces else { return }
        workspaces = w
        save()
    }

    /// The tabs `item` is ordered among in `zone`: its own kind, in the order the strip draws them (tabs of one kind
    /// sit together). Drop positions are decided over this list.
    public func siblings(of item: DockItem, in zone: DockZone) -> [DockItem] {
        switch item {
        case .panel: return layout[zone].panels.map { .panel($0) }
        case .file: return files.files(in: zone).map { .file($0) }
        case .thread: return threads.threads(in: zone).map { .thread($0) }
        case .duckling: return ducklings.ducklings(in: zone).map { .duckling($0) }
        case .terminal: return activeTerminals.terminals(in: zone).map { .terminal($0) }
        }
    }

    /// Takes a drop: moves the tab into `zone`, before `before` when that is the same kind of tab (else at the end).
    @discardableResult
    public func drop(_ item: DockItem, to zone: DockZone, before: DockItem? = nil) -> Bool {
        dragging = nil
        if DragScope.opensPondDashboard(item, on: .strip(zone)) { openPondDashboard?(); return true }
        switch item {
        case .panel(let p):
            var b: DockPanel?
            if case .panel(let other)? = before { b = other }
            update { $0.move(p, to: zone, before: b) }
        case .file(let path):
            var b: String?
            if case .file(let other)? = before { b = other }
            moveFile(path, to: zone, before: b)
        case .thread(let key):
            var b: String?
            if case .thread(let other)? = before { b = other }
            moveThread(key, to: zone, before: b)
        case .terminal(let id):
            var b: UUID?
            if case .terminal(let other)? = before { b = other }
            moveTerminal(id, to: zone, before: b)
        case .duckling(let ref):
            var b: DucklingRef?
            if case .duckling(let other)? = before { b = other }
            moveDuckling(ref, to: zone, before: b)
        }
        return true
    }
}
