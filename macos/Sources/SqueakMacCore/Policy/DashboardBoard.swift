import Foundation

/// The dashboard groups existing workspaces by their agents' actual state. Moving a card is a
/// consequence of activity, never an instruction to change an agent's state.
public enum DashboardLane: String, CaseIterable, Identifiable, Sendable {
    case needsYou, working, done, idle
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .needsYou: "Needs you"
        case .working: "In progress"
        case .done: "Done"
        case .idle: "Idle"
        }
    }
    public var emptyMessage: String {
        switch self {
        case .needsYou: "Nothing waiting for you."
        case .working: "No work running."
        case .done: "Finished work appears here."
        case .idle: "Nothing idle."
        }
    }
}

public struct DashboardColumn: Identifiable, Equatable, Sendable {
    public let lane: DashboardLane
    public let workspaces: [RecentWorkspace]
    public var id: DashboardLane { lane }
    public init(lane: DashboardLane, workspaces: [RecentWorkspace]) {
        self.lane = lane
        self.workspaces = workspaces
    }
}

/// Which workspaces the dashboard shows: all, one project's, or one workspace. Set by the chat header's breadcrumb.
public enum DashboardFilter: Equatable, Sendable {
    case project(String)
    case workspace(id: String, name: String)

    public var label: String {
        switch self {
        case .project(let name): name
        case .workspace(_, let name): name
        }
    }

    /// The filter chip's words: a project is a pond.
    public var chipText: String {
        switch self {
        case .project(let name): "Showing pond \(name)"
        case .workspace(_, let name): "Showing \(name)"
        }
    }

    public func includes(_ item: RecentWorkspace) -> Bool {
        switch self {
        case .project(let name): item.project.caseInsensitiveCompare(name) == .orderedSame
        case .workspace(let id, _): item.workspace.id == id || item.workspace.id.hasPrefix(id + "/")
        }
    }

    public func apply(to columns: [DashboardColumn]) -> [DashboardColumn] {
        columns.map { DashboardColumn(lane: $0.lane, workspaces: $0.workspaces.filter(includes)) }
    }
}

public enum DashboardBoard {
    public static func build(_ tree: SidebarTree, pins: Set<String> = [], now: Date = Date()) -> [DashboardColumn] {
        let count = tree.projects.reduce(0) { $0 + $1.workspaces.count }
        let recent = cards(WorkspaceNavigation.recent(tree, limit: count))
        return DashboardLane.allCases.map { lane in
            let items = recent.filter { self.lane(for: $0.workspace, now: now) == lane }
            return DashboardColumn(lane: lane, workspaces:
                items.filter { pins.contains($0.id) } + items.filter { !pins.contains($0.id) })
        }
    }

    /// Ducks mode folds a pond into one row holding every Duck. A card per row would take its state from one chat and hide
    /// the rest (a working Duck lost behind an errored one), so such a row becomes one card per Duck, each in the lane of
    /// its own chats. A Duck is its `duckId`; a chat with no Duck is its own. Streams stay one card per workspace.
    static func cards(_ recent: [RecentWorkspace]) -> [RecentWorkspace] {
        recent.flatMap { item -> [RecentWorkspace] in
            guard item.workspace.isDucks else { return [item] }
            var order: [String] = []
            var groups: [String: [HostSession]] = [:]
            for chat in item.workspace.chats where chat.archivedAt == nil {
                let key = chat.duckId.flatMap { $0.isEmpty ? nil : $0 } ?? "chat:\(chat.key.stringValue)"
                if groups[key] == nil { order.append(key) }
                groups[key, default: []].append(chat)
            }
            return order.map { key in
                var w = item.workspace
                w.id = "\(item.workspace.id)/\(key)"
                w.chats = groups[key] ?? []
                w.branch = w.chats.compactMap(\.branch).first { !$0.isEmpty }
                w.foldedMark = nil
                return RecentWorkspace(project: item.project, workspace: w)
            }
        }
        .sorted { ($0.workspace.lastActivityAt ?? .distantPast) > ($1.workspace.lastActivityAt ?? .distantPast) }
    }

    public static func lane(for workspace: SidebarWorkspace, now: Date = Date()) -> DashboardLane {
        switch workspace.chats.map({ priority($0, now: now) }).min() {
        case 0, 1: .needsYou
        case 2: .working
        case 3: .done
        default: .idle
        }
    }

    /// The card's stream line: the branch, else the workspace's title. Text only, never a glyph (DESIGN.md §3.3: a glyph
    /// animates only on a working item, and a card's state is its destination chat's own mark).
    public static func streamLine(in workspace: SidebarWorkspace) -> String { workspace.branch ?? workspace.displayTitle }

    /// Open the chat responsible for a card's lane, rather than an unrelated, newer chat.
    public static func destination(in workspace: SidebarWorkspace, now: Date = Date()) -> HostSession? {
        workspace.chats.sorted(by: HomeProjects.before).min { priority($0, now: now) < priority($1, now: now) }
    }

    private static func priority(_ chat: HostSession, now: Date) -> Int {
        if chat.isLoopingNow { return 0 }
        switch chat.state {
        case .blocked where chat.alive != false: return 0
        case .error where SessionGrouping.isRecent(chat, now: now): return 1
        case .working where chat.alive != false: return 2
        case .finished where SessionGrouping.runsDucklings(chat): return 2
        case .finished: return 3
        default: return 4
        }
    }
}
