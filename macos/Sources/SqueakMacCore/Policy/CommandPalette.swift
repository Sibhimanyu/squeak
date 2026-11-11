import Foundation

/// What a palette action does. The app maps each to an existing AppModel method or pane toggle; nothing here acts.
public enum PaletteAction: String, CaseIterable, Sendable, Hashable {
    case newChat, newWorkspace, searchChats
    case toggleSidebar, toggleInspector, toggleTerminal
    case openSettings, openUsage, showShortcuts
    case stopChat, approve, deny
    case commitPush, createPR
    case copyBranch, revealFolder, openInConductor

    public var title: String {
        switch self {
        case .newChat: "New chat"
        case .newWorkspace: "New branch"
        case .searchChats: "Search chats"
        case .toggleSidebar: "Toggle sidebar"
        case .toggleInspector: "Toggle inspector"
        case .toggleTerminal: "Toggle terminal"
        case .openSettings: "Open settings"
        case .openUsage: "Open usage"
        case .showShortcuts: "Keyboard shortcuts"
        case .stopChat: "Stop current chat"
        case .approve: "Approve current request"
        case .deny: "Deny current request"
        case .commitPush: "Commit and push"
        case .createPR: "Create pull request"
        case .copyBranch: "Copy branch name"
        case .revealFolder: "Reveal folder in Finder"
        case .openInConductor: "Open in Conductor"
        }
    }

    /// The registry entry whose keycap the row shows.
    public var shortcut: ShortcutID? {
        switch self {
        case .newChat: .newChat
        case .newWorkspace: .newWorkspace
        case .toggleSidebar: .toggleSidebar
        case .toggleInspector: .toggleInspector
        case .toggleTerminal: .toggleTerminal
        case .openSettings: .settings
        case .showShortcuts: .shortcutList
        case .stopChat: .stop
        case .commitPush: .gitCommitPush
        case .createPR: .gitCreatePR
        case .approve: .allowOnce
        case .deny: .deny
        default: nil
        }
    }

    /// Extra words that find the action ("pr", "quit").
    var keywords: String {
        switch self {
        case .searchChats: "find filter sidebar"
        case .stopChat: "interrupt cancel halt"
        case .approve: "allow yes accept"
        case .deny: "refuse reject no"
        case .commitPush: "git save"
        case .createPR: "pr pull request git"
        case .copyBranch: "git clipboard"
        case .revealFolder: "finder open directory path"
        case .openInConductor: "host"
        case .openSettings: "preferences"
        case .showShortcuts: "keys hotkeys help"
        default: ""
        }
    }
}

/// What the app can do right now: which actions are offered. The palette lists only actions that would work.
public struct PaletteContext: Equatable, Sendable {
    public var chat: HostSession?
    /// Squeak's own chat (the host runs it), so Stop and Approve/Deny reach it.
    public var chatIsNative: Bool
    public var chatWaitsOnApproval: Bool
    public var chatIsWorking: Bool
    public var canOpenInConductor: Bool
    /// The app exposes these for the open chat (a Conductor chat's PR request; commit and push when wired).
    public var canCommitPush: Bool
    public var canCreatePR: Bool
    public var canMakeWorkspace: Bool

    public init(
        chat: HostSession? = nil, chatIsNative: Bool = false, chatWaitsOnApproval: Bool = false, chatIsWorking: Bool = false,
        canOpenInConductor: Bool = false, canCommitPush: Bool = false, canCreatePR: Bool = false, canMakeWorkspace: Bool = false
    ) {
        self.chat = chat
        self.chatIsNative = chatIsNative
        self.chatWaitsOnApproval = chatWaitsOnApproval
        self.chatIsWorking = chatIsWorking
        self.canOpenInConductor = canOpenInConductor
        self.canCommitPush = canCommitPush
        self.canCreatePR = canCreatePR
        self.canMakeWorkspace = canMakeWorkspace
    }

    /// The keycap a row shows. Commit and push and Create PR are bound for Squeak's own chats only (a Conductor chat's
    /// PR goes through its own reply), so a Conductor chat's row carries none.
    func keycap(for a: PaletteAction) -> String? {
        if (a == .createPR || a == .commitPush) && !chatIsNative { return nil }
        return a.shortcut.flatMap { ShortcutRegistry.keycap($0) }
    }

    func offers(_ a: PaletteAction) -> Bool {
        switch a {
        case .newWorkspace: canMakeWorkspace
        case .stopChat: chat != nil && chatIsWorking
        case .approve, .deny: chat != nil && chatIsNative && chatWaitsOnApproval
        case .commitPush: chat != nil && canCommitPush
        case .createPR: chat != nil && canCreatePR
        case .copyBranch: !(chat?.branch ?? "").isEmpty
        case .revealFolder: !(chat?.cwd ?? "").isEmpty
        case .openInConductor: chat != nil && canOpenInConductor
        default: true
        }
    }
}

public enum PaletteGroup: Int, Sendable, Comparable, CaseIterable {
    case recent, chats, workspaces, actions
    public static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }

    public var title: String {
        switch self {
        case .recent: "Recent"
        case .chats: "Chats"
        case .workspaces: "Workspaces"
        case .actions: "Actions"
        }
    }
}

public enum PaletteTarget: Hashable, Sendable {
    case chat(SessionKey)
    /// A workspace (or project): opens its newest chat.
    case workspace(newestChat: SessionKey)
    case action(PaletteAction)
}

public struct PaletteItem: Hashable, Sendable, Identifiable {
    /// Stable across refreshes: `chat:<key>`, `ws:<project>/<workspace>`, `action:<name>`. Recents store it.
    public var id: String
    public var group: PaletteGroup
    public var title: String
    /// The muted context after the title ("squeak · mallard · working").
    public var context: String
    var keywords: String
    public var recency: Date?
    public var shortcut: String?
    public var target: PaletteTarget
    /// A chat's state, for the mark. Nil for the rest.
    public var state: SessionState?
    var agent: String?
}

public struct PaletteSection: Equatable, Sendable, Identifiable {
    public var group: PaletteGroup
    public var items: [PaletteItem]
    public var id: PaletteGroup { group }
}

/// ⌘K (DESIGN.md §8.10, mock f). Groups in fixed order (Chats, Workspaces, Actions); typing filters and ranks by
/// match, then recency; empty shows the recent picks first. `>` lists actions only.
public enum CommandPalette {
    public static let recentLimit = 6
    static let limits: [PaletteGroup: Int] = [.chats: 8, .workspaces: 5, .actions: 8, .recent: 6]

    // MARK: Items

    public static func items(sessions: [HostSession], context: PaletteContext) -> [PaletteItem] {
        var out: [PaletteItem] = []
        let sorted = sessions.sorted(by: HomeProjects.before)
        for s in sorted {
            let project = HomeProjects.projectName(s)
            let workspace = SidebarTreeBuilder.workspaceName([s])
            var parts = [project, workspace]
            if parts[0] == parts[1] { parts.removeLast() }
            parts.append(stateWords(s.state))
            out.append(PaletteItem(
                id: "chat:\(s.key.stringValue)", group: .chats, title: s.distinctTitle ?? s.title,
                context: parts.joined(separator: " · "),
                keywords: [project, workspace, s.branch ?? "", s.agent ?? "", stateWords(s.state), s.title].joined(separator: " "),
                recency: s.lastActivityAt, shortcut: nil, target: .chat(s.key), state: s.state, agent: s.agent))
        }
        // One row per workspace, opening its newest chat.
        var seen = Set<String>()
        for s in sorted {
            let project = HomeProjects.projectName(s)
            let wsKey = SidebarTreeBuilder.workspaceKey(s)
            let id = "ws:\(project)/\(wsKey)"
            guard seen.insert(id).inserted else { continue }
            let mates = sorted.filter { HomeProjects.projectName($0) == project && SidebarTreeBuilder.workspaceKey($0) == wsKey }
            let name = SidebarTreeBuilder.workspaceName(mates)
            let branch = mates.compactMap(\.branch).first { !$0.isEmpty }
            out.append(PaletteItem(
                id: id, group: .workspaces, title: name,
                context: [project, branch].compactMap { $0 }.filter { $0 != name }.joined(separator: " · "),
                keywords: [project, name, branch ?? ""].joined(separator: " "),
                recency: mates.compactMap(\.lastActivityAt).max(), shortcut: nil, target: .workspace(newestChat: s.key), state: nil, agent: nil))
        }
        for a in PaletteAction.allCases where context.offers(a) {
            var ctx = ""
            switch a {
            case .newChat, .newWorkspace:
                if let c = context.chat { ctx = a == .newChat ? "in \(SidebarTreeBuilder.workspaceName([c]))" : "in \(HomeProjects.projectName(c))" }
            case .copyBranch: ctx = context.chat?.branch ?? ""
            case .stopChat, .approve, .deny, .commitPush, .createPR, .openInConductor: ctx = context.chat?.title ?? ""
            default: break
            }
            out.append(PaletteItem(
                id: "action:\(a.rawValue)", group: .actions, title: a.title, context: ctx, keywords: a.keywords,
                recency: nil, shortcut: context.keycap(for: a), target: .action(a), state: nil, agent: nil))
        }
        return out
    }

    static func stateWords(_ s: SessionState) -> String {
        switch s {
        case .working: "working"
        case .blocked: "waiting"
        case .finished: "done"
        case .idle: "idle"
        case .error: "failed"
        case .unknown: ""
        }
    }

    // MARK: Results

    /// `recents` is newest first (`PaletteRecents.ids`).
    public static func results(query: String, items: [PaletteItem], recents: [String] = []) -> [PaletteSection] {
        var q = query.trimmingCharacters(in: .whitespaces)
        var actionsOnly = false
        if q.hasPrefix(">") { actionsOnly = true; q = String(q.dropFirst()).trimmingCharacters(in: .whitespaces) }
        let pool = actionsOnly ? items.filter { $0.group == .actions } : items

        if q.isEmpty {
            var sections: [PaletteSection] = []
            if !actionsOnly {
                let byId = Dictionary(pool.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
                let recent = recents.compactMap { byId[$0] }.prefix(recentLimit).map { item -> PaletteItem in
                    var i = item; i.group = .recent; return i
                }
                if !recent.isEmpty { sections.append(PaletteSection(group: .recent, items: Array(recent))) }
            }
            let shown = Set(sections.flatMap(\.items).map(\.id))
            for g in [PaletteGroup.chats, .workspaces, .actions] {
                var list = pool.filter { $0.group == g && !shown.contains($0.id) }
                if g != .actions { list.sort(by: newest) }
                let cut = Array(list.prefix(limits[g] ?? 8))
                if !cut.isEmpty { sections.append(PaletteSection(group: g, items: cut)) }
            }
            return sections
        }

        var terms = PaletteMatch.fold(q).split(whereSeparator: \.isWhitespace).map(String.init)
        // State and agent words filter chats, as in the phone's dock ("waiting", "claude").
        var states = Set<SessionState>(), agents = Set<String>()
        terms.removeAll { t in
            switch t {
            case "waiting": states.insert(.blocked); return true
            case "working": states.insert(.working); return true
            case "failed": states.insert(.error); return true
            case "claude", "codex": agents.insert(t); return true
            default: return false
            }
        }
        let filtering = !states.isEmpty || !agents.isEmpty
        var scored: [PaletteGroup: [(PaletteItem, Int)]] = [:]
        for item in pool {
            if filtering {
                guard item.group == .chats else { continue }
                if !states.isEmpty, !(item.state.map(states.contains) ?? false) { continue }
                if !agents.isEmpty, !(item.agent.map { agents.contains($0) } ?? false) { continue }
            }
            let title = PaletteMatch.fold(item.title)
            let rest = PaletteMatch.fold(item.context + " " + item.keywords)
            var total = 0
            var ok = true
            for t in terms {
                let a = PaletteMatch.score(t, in: title).map { $0 * 2 }
                let b = PaletteMatch.score(t, in: rest)
                guard let best = [a, b].compactMap({ $0 }).max() else { ok = false; break }
                total += best
            }
            guard ok else { continue }
            scored[item.group, default: []].append((item, total))
        }
        return [PaletteGroup.chats, .workspaces, .actions].compactMap { g in
            let list = (scored[g] ?? []).sorted { x, y in
                if x.1 != y.1 { return x.1 > y.1 }
                return newest(x.0, y.0)
            }.prefix(limits[g] ?? 8).map(\.0)
            return list.isEmpty ? nil : PaletteSection(group: g, items: Array(list))
        }
    }

    static func newest(_ x: PaletteItem, _ y: PaletteItem) -> Bool {
        switch (x.recency, y.recency) {
        case let (a?, b?) where a != b: return a > b
        case (nil, .some): return false
        case (.some, nil): return true
        default: return x.title.localizedCaseInsensitiveCompare(y.title) == .orderedAscending
        }
    }
}

/// The picks made from the palette, newest first, kept by id so a chat that is gone just drops out.
public struct PaletteRecents: Codable, Equatable, Sendable {
    public static let capacity = 12
    public private(set) var ids: [String]

    public init(ids: [String] = []) { self.ids = ids }

    public mutating func record(_ id: String) {
        ids.removeAll { $0 == id }
        ids.insert(id, at: 0)
        if ids.count > Self.capacity { ids.removeLast(ids.count - Self.capacity) }
    }
}
