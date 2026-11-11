import Foundation

/// DESIGN.md §8.10: moving between workspaces and chats without the mouse, and the Home page's list. All of it is
/// decided here, apart from the views, over the sidebar's own tree so every route agrees about order.
public struct RecentWorkspace: Equatable, Sendable, Identifiable {
    public var project: String
    public var workspace: SidebarWorkspace
    public var id: String { workspace.id }
}

/// Pinned workspaces: the person's own record, kept in one saved set of workspace ids.
public struct WorkspacePins: Codable, Equatable, Sendable {
    public private(set) var ids: Set<String> = []
    public init(ids: Set<String> = []) { self.ids = ids }

    public func contains(_ id: String) -> Bool { ids.contains(id) }

    @discardableResult
    public mutating func toggle(_ id: String) -> Bool {
        if ids.remove(id) == nil { ids.insert(id); return true }
        return false
    }
}

/// Tabs the person closed, per workspace, most recent last: ⇧⌘T brings the latest back. Closing hides the tab only;
/// the chat itself is untouched.
public struct ClosedTabs: Codable, Equatable, Sendable {
    public static let capacity = 20
    private var stacks: [String: [String]] = [:]
    public init() {}

    public func hasClosed(in workspace: String) -> Bool { !(stacks[workspace]?.isEmpty ?? true) }

    public func isClosed(_ chat: String, in workspace: String) -> Bool { stacks[workspace]?.contains(chat) ?? false }

    public mutating func close(_ chat: String, in workspace: String) {
        var s = stacks[workspace] ?? []
        s.removeAll { $0 == chat }
        s.append(chat)
        if s.count > Self.capacity { s.removeFirst(s.count - Self.capacity) }
        stacks[workspace] = s
    }

    /// The most recently closed tab that is still there (`available` = the workspace's chats now), removed from the stack.
    public mutating func reopen(in workspace: String, available: Set<String>) -> String? {
        var s = stacks[workspace] ?? []
        while let last = s.popLast() {
            if available.contains(last) { stacks[workspace] = s; return last }
        }
        stacks[workspace] = s
        return nil
    }

    /// A tab opened some other way (the sidebar, a notification) is no longer closed.
    public mutating func forget(_ chat: String, in workspace: String) { stacks[workspace]?.removeAll { $0 == chat } }
}

public enum WorkspaceNavigation {
    /// Pinned workspaces first, each group keeping the tree's newest-first order.
    public static func pinnedFirst(_ list: [SidebarWorkspace], pins: Set<String>) -> [SidebarWorkspace] {
        list.filter { pins.contains($0.id) } + list.filter { !pins.contains($0.id) }
    }

    /// Every workspace in the order the sidebar draws them.
    public static func flat(_ tree: SidebarTree, pins: Set<String> = []) -> [SidebarWorkspace] {
        tree.projects.flatMap { pinnedFirst($0.workspaces, pins: pins) }
    }

    /// Home's list: workspaces with something to show, newest first across projects (ties by name).
    public static func recent(_ tree: SidebarTree, limit: Int = 12) -> [RecentWorkspace] {
        let all = tree.projects.flatMap { p in p.workspaces.map { RecentWorkspace(project: p.name, workspace: $0) } }
        let sorted = all.sorted { a, b in
            switch (a.workspace.lastActivityAt, b.workspace.lastActivityAt) {
            case let (x?, y?) where x != y: return x > y
            case (nil, .some): return false
            case (.some, nil): return true
            default: return a.workspace.displayTitle.lowercased() < b.workspace.displayTitle.lowercased()
            }
        }
        return Array(sorted.prefix(max(0, limit)))
    }

    /// The workspace `delta` steps from the one holding `current` (wrapping); the first or last when none is open.
    public static func step(from current: SessionKey?, by delta: Int, in tree: SidebarTree, pins: Set<String> = []) -> SidebarWorkspace? {
        let list = flat(tree, pins: pins)
        guard !list.isEmpty else { return nil }
        guard let current, let i = list.firstIndex(where: { $0.chats.contains { $0.key == current } }) else {
            return delta >= 0 ? list.first : list.last
        }
        return list[((i + delta) % list.count + list.count) % list.count]
    }

    /// The chat to jump to for "next chat needing attention": the next one waiting on the person after `current` in
    /// sidebar order (wrapping), else the next finished and unread one. Never `current` itself.
    public static func nextAttention(
        after current: SessionKey?, in tree: SidebarTree, pins: Set<String> = [], mark: (HostSession) -> ChatMark?
    ) -> SessionKey? {
        let chats = flat(tree, pins: pins).flatMap(\.chats)
        guard !chats.isEmpty else { return nil }
        let start = current.flatMap { c in chats.firstIndex { $0.key == c } }.map { $0 + 1 } ?? 0
        let rotated = Array(chats[start...] + chats[..<start]).filter { $0.key != current }
        for kind in [ChatMarkKind.waiting, .unread] {
            if let hit = rotated.first(where: { mark($0)?.kind == kind }) { return hit.key }
        }
        return nil
    }

    /// How many chats other than `current` need the person (waiting or finished unread): the pill's number.
    public static func attentionCount(excluding current: SessionKey?, in tree: SidebarTree, mark: (HostSession) -> ChatMark?) -> Int {
        tree.projects.flatMap(\.workspaces).flatMap(\.chats).filter { c in
            guard c.key != current, let k = mark(c)?.kind else { return false }
            return k == .waiting || k == .unread
        }.count
    }
}

/// The navigation button above the composer (and ⌥⌘L): where the next chat that needs the person is, and how many do.
public struct AttentionJump: Equatable, Sendable {
    public var key: SessionKey
    public var kind: ChatMarkKind
    public var count: Int

    /// Requests need a reply; updates are finished work that has not been read yet.
    /// The count includes every other thread needing attention.
    public var label: String {
        let base = kind == .waiting ? "Next request" : "Next update"
        return count > 1 ? "\(base) · \(count)" : base
    }

    public static func make(after current: SessionKey?, in tree: SidebarTree, pins: Set<String> = [], mark: (HostSession) -> ChatMark?) -> AttentionJump? {
        guard let key = WorkspaceNavigation.nextAttention(after: current, in: tree, pins: pins, mark: mark),
              let chat = tree.projects.flatMap(\.workspaces).flatMap(\.chats).first(where: { $0.key == key }),
              let kind = mark(chat)?.kind else { return nil }
        return AttentionJump(key: key, kind: kind, count: WorkspaceNavigation.attentionCount(excluding: current, in: tree, mark: mark))
    }
}
