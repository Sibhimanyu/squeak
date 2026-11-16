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

    public static func of(zone: DockZone, layout: DockLayout) -> DockPlusAction {
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
            right.collapsed.toggle()
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
    public static let shared = DockStore()

    public private(set) var workspaces: DockWorkspaces
    /// Open files placed outside the centre (session state, never saved).
    public private(set) var files = DockFiles()
    /// A panel being dragged right now (not saved): zones that could take it show their drop strips.
    public var dragging: DockItem?
    /// The panel tab under the pointer (not observed): a drag that starts there is a panel drag.
    @ObservationIgnored public var hoveredTab: DockItem?
    @ObservationIgnored private let defaults: UserDefaults

    public var layout: DockLayout { workspaces.active.current }

    /// First load builds Default from the old `@AppStorage` values and leaves those keys where they are.
    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.defaultsKey), let saved = try? JSONDecoder().decode(DockWorkspaces.self, from: data) {
            workspaces = saved
        } else {
            let layout = DockLayout.migrated(
                codeView: defaults.bool(forKey: "inspectorCodeView"), terminalOpen: defaults.bool(forKey: "terminalOpen"),
                inspectorOpen: defaults.bool(forKey: "inspectorOpen"), inspectorWidth: defaults.double(forKey: "inspectorWidth"),
                terminalHeight: defaults.double(forKey: "terminalPanelHeight"))
            workspaces = .initial(migratedFrom: layout)
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
        for z in [DockZone.right, .bottom] where before[z].selected != layout[z].selected { files.deselect(z) }
    }

    /// Puts an open file in a zone (the centre = back to the strip); a folded side zone opens for it.
    public func moveFile(_ path: String, to zone: DockZone, before: String? = nil) {
        files.move(path, to: zone, before: before)
        if zone == .centre { update { $0.selectChats() } } else { update { $0.setCollapsed(false, for: zone) } }
    }

    /// A panel tab was pressed in a zone: it shows over that zone's file.
    public func selectPanel(_ panel: DockPanel, in zone: DockZone) {
        files.deselect(zone)
        update { $0.select(panel); $0.setCollapsed(false, for: zone) }
    }

    public func selectFile(_ path: String) {
        files.select(path)
        let z = files.zone(of: path)
        if z != .centre { update { $0.setCollapsed(false, for: z) } }
    }

    /// Drops the placements of files that are no longer open.
    public func pruneFiles(keeping open: Set<String>) {
        let p = files.pruned(keeping: open)
        if p != files { files = p }
    }

    /// Changes the workspaces themselves (switch, save, reset, ...).
    public func edit(_ change: (inout DockWorkspaces) -> Void) {
        var w = workspaces
        change(&w)
        guard w != workspaces else { return }
        workspaces = w
        save()
    }

    /// Takes a drop: moves the tab into `zone`, before `before` when that is the same kind of tab (else at the end).
    @discardableResult
    public func drop(_ item: DockItem, to zone: DockZone, before: DockItem? = nil) -> Bool {
        dragging = nil
        switch item {
        case .panel(let p):
            var b: DockPanel?
            if case .panel(let other)? = before { b = other }
            update { $0.move(p, to: zone, before: b) }
        case .file(let path):
            var b: String?
            if case .file(let other)? = before { b = other }
            moveFile(path, to: zone, before: b)
        }
        return true
    }
}
