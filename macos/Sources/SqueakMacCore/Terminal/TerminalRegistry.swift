import Foundation

public struct TerminalTab: Equatable, Identifiable, Sendable {
    public let id: UUID
    /// 1, 2, 3 … within its workspace, never reused while the workspace lives, so titles do not shuffle on a close.
    public let number: Int
    public init(id: UUID = UUID(), number: Int) { self.id = id; self.number = number }
}

/// The terminals kept alive while the app runs: one workspace (its folder, `TerminalWorkspace.key`) holds its tabs
/// and which one is showing. Pure bookkeeping; the live shells are owned by the app's controller, which mirrors this.
public struct TerminalRegistry: Equatable, Sendable {
    public struct Workspace: Equatable, Sendable {
        public var tabs: [TerminalTab] = []
        public var selected: UUID?
        var nextNumber = 1
    }

    public private(set) var workspaces: [String: Workspace] = [:]

    public init() {}

    public func tabs(_ workspace: String) -> [TerminalTab] { workspaces[workspace]?.tabs ?? [] }

    public func selected(_ workspace: String) -> TerminalTab? {
        guard let w = workspaces[workspace], let id = w.selected else { return nil }
        return w.tabs.first { $0.id == id }
    }

    public var allTabs: [UUID] { workspaces.values.flatMap { $0.tabs.map(\.id) } }

    /// The workspace's first terminal on first use; an existing workspace is left exactly as it is, which is how
    /// switching between chats of one workspace keeps its shell.
    @discardableResult
    public mutating func ensure(_ workspace: String) -> TerminalTab {
        if let t = selected(workspace) { return t }
        if let t = workspaces[workspace]?.tabs.first { workspaces[workspace]?.selected = t.id; return t }
        return add(workspace)
    }

    @discardableResult
    public mutating func add(_ workspace: String) -> TerminalTab {
        var w = workspaces[workspace] ?? Workspace()
        let tab = TerminalTab(number: w.nextNumber)
        w.nextNumber += 1
        w.tabs.append(tab)
        w.selected = tab.id
        workspaces[workspace] = w
        return tab
    }

    public mutating func select(_ workspace: String, _ id: UUID) {
        guard workspaces[workspace]?.tabs.contains(where: { $0.id == id }) == true else { return }
        workspaces[workspace]?.selected = id
    }

    /// Removes a tab; the neighbour to its left (else right) is shown. Closing the last one empties the workspace,
    /// so the next time the panel opens there it starts a fresh shell.
    @discardableResult
    public mutating func close(_ workspace: String, _ id: UUID) -> Bool {
        guard var w = workspaces[workspace], let i = w.tabs.firstIndex(where: { $0.id == id }) else { return false }
        w.tabs.remove(at: i)
        if w.selected == id { w.selected = w.tabs.isEmpty ? nil : w.tabs[max(0, i - 1)].id }
        if w.tabs.isEmpty { workspaces[workspace] = nil } else { workspaces[workspace] = w }
        return true
    }

    /// The tab after (or before) the selected one, wrapping, for ⌃Tab-style moves.
    public func neighbour(_ workspace: String, forward: Bool) -> UUID? {
        guard let w = workspaces[workspace], w.tabs.count > 1, let cur = w.selected, let i = w.tabs.firstIndex(where: { $0.id == cur }) else { return nil }
        return w.tabs[(i + (forward ? 1 : w.tabs.count - 1)) % w.tabs.count].id
    }
}
