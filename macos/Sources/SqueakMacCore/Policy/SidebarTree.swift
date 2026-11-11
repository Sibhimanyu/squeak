import Foundation

/// The workbench sidebar's tree (DESIGN.md §8.10): project, then workspace, then chat. Every level is newest
/// first by last activity and ties go by name, the same rule as Home's cards (`HomeProjects`). There are no
/// groups and no state words: a chat's state is a mark (`ChatMark`), and a folded project or workspace shows the
/// highest-priority mark inside.
public struct SidebarWorkspace: Equatable, Sendable, Identifiable {
    /// Stable across refreshes: the project, then the Conductor workspace id, else the folder, else the branch.
    public var id: String
    public var name: String
    public var branch: String?
    /// Newest first.
    public var chats: [HostSession]
    public var lastActivityAt: Date? { chats.compactMap(\.lastActivityAt).max() }
    /// The branch, unless it only repeats the name (`mallard` or `user/mallard` under "mallard").
    public var branchLabel: String? { Self.branchLabel(branch: branch, name: name) }
    public static func branchLabel(branch: String?, name: String) -> String? {
        guard let b = branch, !b.isEmpty, (b as NSString).lastPathComponent != name, b != name else { return nil }
        return b
    }
    /// The highest-priority mark inside (waiting, failed, unread, working); nil when no chat has one.
    public var foldedMark: FoldedMark?
}

public struct SidebarProject: Equatable, Sendable, Identifiable {
    public var name: String
    /// Newest first.
    public var workspaces: [SidebarWorkspace]
    public var id: String { name }
    public var lastActivityAt: Date? { workspaces.compactMap(\.lastActivityAt).max() }
    public var chatCount: Int { workspaces.reduce(0) { $0 + $1.chats.count } }
    public var foldedMark: FoldedMark? { FoldedMark.combine(workspaces.compactMap(\.foldedMark)) }
}

public struct SidebarTree: Equatable, Sendable {
    public var projects: [SidebarProject]

    /// The workspace a chat sits in, and its project.
    public func place(of key: SessionKey) -> (project: SidebarProject, workspace: SidebarWorkspace)? {
        for p in projects {
            for w in p.workspaces where w.chats.contains(where: { $0.key == key }) { return (p, w) }
        }
        return nil
    }
}

public enum SidebarTreeBuilder {
    public static func workspaceKey(_ s: HostSession) -> String {
        for v in [s.conductorWorkspaceId, s.cwd, s.branch] {
            if let v, !v.isEmpty { return v }
        }
        return "none"
    }

    /// The folder's own name (a Conductor workspace's city or bird, a worktree), else the branch.
    static func workspaceName(_ chats: [HostSession]) -> String {
        for s in chats {
            if let n = s.workspaceName?.trimmingCharacters(in: .whitespaces), !n.isEmpty { return n }
        }
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
    public static func build(
        _ sessions: [HostSession], now: Date = Date(), keeping: SessionKey? = nil, isUnread: (HostSession) -> Bool = { _ in false }
    ) -> SidebarTree {
        let projects = HomeProjects.build(sessions, now: now, keeping: keeping.map { [$0] } ?? []).map { p -> SidebarProject in
            var buckets: [String: [HostSession]] = [:]
            for s in p.sessions { buckets[workspaceKey(s), default: []].append(s) }
            let workspaces = buckets.map { key, chats -> SidebarWorkspace in
                let sorted = chats.sorted(by: HomeProjects.before)
                let branch = sorted.compactMap { $0.branch }.first { !$0.isEmpty }
                return SidebarWorkspace(
                    id: "\(p.name)/\(key)", name: workspaceName(sorted), branch: branch, chats: sorted,
                    foldedMark: FoldedMark.top(sorted.compactMap { ChatMark.of($0, unread: isUnread($0), now: now) }))
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
        return SidebarTree(projects: projects)
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

/// A chat's title in the workbench. The fallback Conductor writes for a chat nobody named, "<repo> · <workspace>",
/// only repeats the workspace the row already sits under, so it reads as the first thing said, or "New chat".
public enum ChatTitle {
    public static let placeholder = "New chat"
    static let firstMessageMax = 60

    /// True when the chat's own title is empty, "Untitled", or exactly "<repo> · <workspace>" / "<repo> · <branch>".
    /// A terminal session's title is only a folder or a command, so it never counts.
    public static func isFallback(_ s: HostSession) -> Bool {
        let t = s.title.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.source == .terminal { return false }
        if t.isEmpty || t.lowercased() == "untitled" { return true }
        guard let repo = s.repoName, !repo.isEmpty else { return false }
        var tails = [SidebarTreeBuilder.workspaceName([s])]
        if let b = s.branch, !b.isEmpty { tails.append(b); tails.append((b as NSString).lastPathComponent) }
        if let w = s.conductorWorkspaceId, !w.isEmpty { tails.append(w) }
        return tails.contains { t.caseInsensitiveCompare("\(repo) · \($0)") == .orderedSame }
    }

    /// `headline` unless the title is the fallback, then the first message (one line, clipped) or "New chat".
    public static func resolve(_ s: HostSession, headline: String, firstMessage: String?) -> String {
        guard isFallback(s) else { return headline }
        let flat = (firstMessage ?? "").split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !flat.isEmpty else { return placeholder }
        return flat.count > firstMessageMax ? String(flat.prefix(firstMessageMax)).trimmingCharacters(in: .whitespaces) + "…" : flat
    }
}
