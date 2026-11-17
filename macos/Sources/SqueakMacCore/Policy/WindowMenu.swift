import Foundation

/// The Window menu's panel list, the way Photoshop and Illustrator have it: every panel by name, a checkmark when it is
/// open, a choice opens it (to its last place, else its home zone) and brings it forward, a checked one closes it.
/// Pure: the views draw `items` and run `perform`.
public enum WindowMenu {
    public enum ItemID: Hashable, Sendable {
        case sidebar, inspector, panel(DockPanel)
    }

    public struct Item: Equatable, Sendable, Identifiable {
        public var id: ItemID
        public var title: String
        public var symbol: String
        public var checked: Bool
        /// The shortcut shown beside it (the registry's first chord).
        public var shortcut: ShortcutID?
    }

    /// What choosing an item does: a new layout, or the terminal's own toggle (shells live outside the layout).
    public enum Action: Equatable, Sendable {
        case layout(DockLayout)
        case toggleTerminal
    }

    /// Sidebar, the right zone (Inspector), then one item per panel in `DockPanel.allCases` order.
    public static func items(layout: DockLayout, terminalShowing: Bool) -> [Item] {
        var out = [
            Item(id: .sidebar, title: "Sidebar", symbol: "sidebar.left", checked: !layout.sidebarCollapsed, shortcut: .toggleSidebar),
            Item(id: .inspector, title: "Inspector", symbol: "sidebar.right", checked: isInspectorOpen(layout), shortcut: .toggleInspector),
        ]
        for p in DockPanel.allCases {
            let checked = p == .terminal ? (terminalShowing || layout.isShowing(.terminal)) : layout.isShowing(p)
            out.append(Item(id: .panel(p), title: p.title, symbol: p.symbol, checked: checked, shortcut: shortcut(for: p)))
        }
        return out
    }

    public static func isInspectorOpen(_ layout: DockLayout) -> Bool {
        !layout.right.panels.isEmpty && !layout.right.collapsed
    }

    static func shortcut(for panel: DockPanel) -> ShortcutID? {
        switch panel {
        case .code: return .toggleCode
        case .terminal: return .toggleTerminal
        case .pond, .thread: return nil
        }
    }

    /// Choosing `id` from the menu.
    public static func perform(_ id: ItemID, on layout: DockLayout, terminalShowing: Bool) -> Action {
        var l = layout
        switch id {
        case .sidebar:
            l.sidebarCollapsed.toggle()
        case .inspector:
            if isInspectorOpen(l) { l.right.collapsed = true } else { l.toggleRight(); l.right.collapsed = false }
        case .panel(.terminal):
            return .toggleTerminal
        case .panel(let p):
            if l.isShowing(p) { l.close(p) } else { l.show(p) }
        }
        return .layout(l)
    }

    /// "Reset Essentials" in Adobe's words: always there, always enabled.
    public static func resetTitle(workspace name: String) -> String { "Reset \(name)" }
    public static let newWorkspaceTitle = "New Workspace…"
    public static let deleteWorkspaceTitle = "Delete Workspace…"
}
