import Foundation

/// The workbench sidebar's tree (DESIGN.md §8.10): project, then workspace, then chat. Every level is newest
/// first by last activity and ties go by name, the same rule as Home's cards (`HomeProjects`); urgency lives
/// in the separate Needs you group, never in the order. A chat that needs you appears in that group and in
/// its own place in the tree.
public struct SidebarWorkspace: Equatable, Sendable, Identifiable {
    /// Stable across refreshes: the project, then the Conductor workspace id, else the folder, else the branch.
    public var id: String
    public var name: String
    public var branch: String?
    /// Newest first.
    public var chats: [HostSession]
    public var lastActivityAt: Date? { chats.compactMap(\.lastActivityAt).max() }
    /// The highest-priority state inside (needs you, working, done, error); nil when every chat is idle.
    public var topState: SessionSectionKind?
}

public struct SidebarProject: Equatable, Sendable, Identifiable {
    public var name: String
    /// Newest first.
    public var workspaces: [SidebarWorkspace]
    public var id: String { name }
    public var lastActivityAt: Date? { workspaces.compactMap(\.lastActivityAt).max() }
    public var chatCount: Int { workspaces.reduce(0) { $0 + $1.chats.count } }
    public var topState: SessionSectionKind? { SidebarTreeBuilder.top(workspaces.compactMap(\.topState)) }
}

public struct SidebarTree: Equatable, Sendable {
    /// Every chat waiting on the person, newest first.
    public var needsYou: [HostSession]
    public var projects: [SidebarProject]
    public var working: Int

    /// The workspace a chat sits in, and its project.
    public func place(of key: SessionKey) -> (project: SidebarProject, workspace: SidebarWorkspace)? {
        for p in projects {
            for w in p.workspaces where w.chats.contains(where: { $0.key == key }) { return (p, w) }
        }
        return nil
    }

    /// "1 working · 1 needs you", or nil when neither.
    public var totals: String? {
        var parts: [String] = []
        if working > 0 { parts.append("\(working) working") }
        if !needsYou.isEmpty { parts.append("\(needsYou.count) needs you") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

public enum SidebarTreeBuilder {
    /// Lower is more urgent.
    static func rank(_ k: SessionSectionKind) -> Int {
        switch k {
        case .needsYou: 0
        case .working: 1
        case .done: 2
        case .error: 3
        case .idle: 4
        }
    }

    static func top(_ kinds: [SessionSectionKind]) -> SessionSectionKind? {
        kinds.min { rank($0) < rank($1) }
    }

    public static func workspaceKey(_ s: HostSession) -> String {
        for v in [s.conductorWorkspaceId, s.cwd, s.branch] {
            if let v, !v.isEmpty { return v }
        }
        return "none"
    }

    /// The folder's own name (a Conductor workspace's city or bird, a worktree), else the branch.
    static func workspaceName(_ chats: [HostSession]) -> String {
        for s in chats {
            if let c = s.cwd, !c.isEmpty {
                let last = (c as NSString).lastPathComponent
                if !last.isEmpty, last != "/" { return last }
            }
        }
        for s in chats {
            if let b = s.branch, !b.isEmpty { return (b as NSString).lastPathComponent }
        }
        return "Chats"
    }

    /// Chats idle for over a day stay off the tree (search finds them), except `keeping`, the one on screen.
    public static func build(_ sessions: [HostSession], now: Date = Date(), keeping: SessionKey? = nil) -> SidebarTree {
        let projects = HomeProjects.build(sessions, now: now, keeping: keeping.map { [$0] } ?? []).map { p -> SidebarProject in
            var buckets: [String: [HostSession]] = [:]
            for s in p.sessions { buckets[workspaceKey(s), default: []].append(s) }
            let workspaces = buckets.map { key, chats -> SidebarWorkspace in
                let sorted = chats.sorted(by: HomeProjects.before)
                let branch = sorted.compactMap { $0.branch }.first { !$0.isEmpty }
                return SidebarWorkspace(
                    id: "\(p.name)/\(key)", name: workspaceName(sorted), branch: branch, chats: sorted,
                    topState: top(sorted.map { SessionGrouping.kind(of: $0, now: now) }.filter { $0 != .idle }))
            }
            .sorted { a, b in
                switch (a.lastActivityAt, b.lastActivityAt) {
                case let (x?, y?) where x != y: return x > y
                case (nil, .some): return false
                case (.some, nil): return true
                default: return a.name.lowercased() < b.name.lowercased()
                }
            }
            return SidebarProject(name: p.name, workspaces: workspaces)
        }
        let all = projects.flatMap { $0.workspaces.flatMap(\.chats) }
        return SidebarTree(
            needsYou: all.filter { SessionGrouping.kind(of: $0, now: now) == .needsYou }.sorted(by: HomeProjects.before),
            projects: projects,
            working: all.filter { SessionGrouping.kind(of: $0, now: now) == .working }.count)
    }
}

/// A short age for a row's corner: "now", "5m", "2h", "3d", "2w".
public enum RelativeAge {
    public static func short(_ date: Date?, now: Date = Date()) -> String {
        guard let date else { return "" }
        let s = max(0, now.timeIntervalSince(date))
        switch s {
        case ..<60: return "now"
        case ..<3600: return "\(Int(s / 60))m"
        case ..<86_400: return "\(Int(s / 3600))h"
        case ..<(7 * 86_400): return "\(Int(s / 86_400))d"
        default: return "\(Int(s / (7 * 86_400)))w"
        }
    }
}
