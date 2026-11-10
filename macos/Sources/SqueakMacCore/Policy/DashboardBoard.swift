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
        case .idle: "No idle workspaces."
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

    public func includes(_ item: RecentWorkspace) -> Bool {
        switch self {
        case .project(let name): item.project.caseInsensitiveCompare(name) == .orderedSame
        case .workspace(let id, _): item.workspace.id == id
        }
    }

    public func apply(to columns: [DashboardColumn]) -> [DashboardColumn] {
        columns.map { DashboardColumn(lane: $0.lane, workspaces: $0.workspaces.filter(includes)) }
    }
}

public enum DashboardBoard {
    public static func build(_ tree: SidebarTree, pins: Set<String> = [], now: Date = Date()) -> [DashboardColumn] {
        let count = tree.projects.reduce(0) { $0 + $1.workspaces.count }
        let recent = WorkspaceNavigation.recent(tree, limit: count)
        return DashboardLane.allCases.map { lane in
            let items = recent.filter { self.lane(for: $0.workspace, now: now) == lane }
            return DashboardColumn(lane: lane, workspaces:
                items.filter { pins.contains($0.id) } + items.filter { !pins.contains($0.id) })
        }
    }

    public static func lane(for workspace: SidebarWorkspace, now: Date = Date()) -> DashboardLane {
        switch workspace.chats.map({ priority($0, now: now) }).min() {
        case 0, 1: .needsYou
        case 2: .working
        case 3: .done
        default: .idle
        }
    }

    /// Open the chat responsible for a card's lane, rather than an unrelated, newer chat.
    public static func destination(in workspace: SidebarWorkspace, now: Date = Date()) -> HostSession? {
        workspace.chats.sorted(by: HomeProjects.before).min { priority($0, now: now) < priority($1, now: now) }
    }

    private static func priority(_ chat: HostSession, now: Date) -> Int {
        switch chat.state {
        case .blocked where chat.alive != false: 0
        case .error where SessionGrouping.isRecent(chat, now: now): 1
        case .working where chat.alive != false: 2
        case .finished: 3
        default: 4
        }
    }
}
