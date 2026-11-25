import Foundation

// The rail's one-shot popover lists (DESIGN.md 8.12): what each shows, in what order. Pure: the views draw these rows and a
// pick opens a tab through the existing open-tab API.

// MARK: Changes

public struct RailChangeRow: Equatable, Identifiable, Sendable {
    public var path: String
    /// "A", "M", "D" or "R".
    public var status: String
    public var added: Int
    public var removed: Int
    public var id: String { path }
    public init(path: String, status: String, added: Int, removed: Int) {
        self.path = path; self.status = status; self.added = added; self.removed = removed
    }
}

/// One Duck's (or Main's) changed files.
public struct RailChangeSection: Equatable, Identifiable, Sendable {
    public var id: String
    /// The Duck's name, or "Main".
    public var title: String
    public var branch: String?
    /// The chat the diff tabs read from; nil when no chat on this Mac works there, and the rows then only list.
    public var sessionKey: String?
    public var rows: [RailChangeRow]
    /// Changed files the host did not list (its list is capped).
    public var hidden: Int
    public var isDuck: Bool

    /// "Review all from Pip": opens every one of this Duck's changes in one tab. Only for a Duck with a chat.
    public var reviewAllLabel: String? { isDuck && sessionKey != nil && !rows.isEmpty ? "Review all from \(title)" : nil }
}

public enum RailChanges {
    public static let mainTitle = "Main"

    /// A Pond's changes by Duck, then Main's uncommitted ones. Ducks with nothing changed are left out; the host's order is
    /// kept (the Duck with the newest work first). `sessions` finds the chat behind each Duck, newest activity wins;
    /// `mainSessionKey` is a chat working in the Pond's own folder.
    public static func pondSections(_ changes: HostPondChanges, sessions: [HostSession], mainSessionKey: String?) -> [RailChangeSection] {
        var out: [RailChangeSection] = []
        for duck in changes.ducks where !duck.changes.files.isEmpty {
            out.append(RailChangeSection(
                id: "duck:\(duck.duckId)", title: duck.duckName, branch: duck.branch.isEmpty ? nil : duck.branch,
                sessionKey: sessionKey(forDuck: duck.duckId, in: sessions), rows: duck.changes.files.map(row),
                hidden: max(0, duck.changes.fileCount - duck.changes.files.count), isDuck: true))
        }
        if let main = changes.main, !main.changes.files.isEmpty {
            out.append(RailChangeSection(
                id: "main", title: mainTitle, branch: main.branch, sessionKey: mainSessionKey, rows: main.changes.files.map(row),
                hidden: max(0, main.changes.fileCount - main.changes.files.count), isDuck: false))
        }
        return out
    }

    /// A Duck view's list: that Duck's changes only, from its chat's own list.
    public static func duckSection(name: String, duckId: String?, branch: String?, sessionKey: String, files: [DaemonChanges.File]) -> [RailChangeSection] {
        guard !files.isEmpty else { return [] }
        return [RailChangeSection(
            id: "duck:\(duckId ?? sessionKey)", title: name, branch: branch, sessionKey: sessionKey,
            rows: files.map { RailChangeRow(path: $0.path, status: $0.status, added: $0.added, removed: $0.removed) },
            hidden: 0, isDuck: true)]
    }

    /// The chat that stands for a Duck: the one with the newest activity.
    public static func sessionKey(forDuck duckId: String, in sessions: [HostSession]) -> String? {
        sessions.filter { $0.duckId == duckId }
            .max { ($0.lastActivityAt ?? .distantPast) < ($1.lastActivityAt ?? .distantPast) }?
            .key.stringValue
    }

    /// The rail's Changes badge: every changed file across the sections.
    public static func total(_ sections: [RailChangeSection]) -> Int {
        sections.reduce(0) { $0 + $1.rows.count + $1.hidden }
    }

    /// What an empty list says.
    public static func emptyLine(isPond: Bool) -> String {
        isPond ? "Nothing has changed in this Pond." : "This Duck has not changed anything."
    }

    private static func row(_ f: HostChangeFile) -> RailChangeRow {
        RailChangeRow(path: f.path, status: f.status, added: f.added, removed: f.removed)
    }
}

// MARK: Artifacts

public enum RailArtifacts {
    /// The Pond's artifacts grouped by Duck, the current Duck's own group first (the rest keep the newest-first order).
    public static func groups(_ items: [ArtifactItem], currentDuckId: String?, query: String = "") -> [ArtifactGroup] {
        let groups = Artifacts.grouped(Artifacts.filter(items, query: query))
        guard let currentDuckId, let at = groups.firstIndex(where: { $0.id == currentDuckId }), at > 0 else { return groups }
        var out = groups
        out.insert(out.remove(at: at), at: 0)
        return out
    }
}

// MARK: Files

/// What the Files list shows before a search: files Ducks opened or showed, newest first, then the tree.
public struct RailRecentFiles: Equatable, Sendable {
    public static let cap = 8
    public private(set) var paths: [String] = []
    public init() {}

    /// Notes a file opened or shown; it moves to the front and the list stays within the cap.
    public mutating func note(_ path: String) {
        guard !path.isEmpty else { return }
        paths.removeAll { $0 == path }
        paths.insert(path, at: 0)
        if paths.count > Self.cap { paths.removeLast(paths.count - Self.cap) }
    }

    /// The list to draw: what was noted, then files still open as tabs that were not noted (a restored tab), within the cap.
    public func list(openTabs: [String]) -> [String] {
        var out = paths
        for p in openTabs.reversed() where !out.contains(p) { out.append(p) }
        return Array(out.prefix(Self.cap))
    }
}

// MARK: Tasks

/// One row of the Tasks list: a Task that is not finished, and the Duck a pick opens (nil when no Duck has it yet).
public struct RailTaskRow: Equatable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var state: RoomTaskState
    /// The Duck's name, shown in the row's detail.
    public var duckName: String?
    /// The chat of the Duck holding the Task; a pick opens it.
    public var duckSessionId: String?

    /// The line under the title: "Working · Pip", or the bare state when no Duck has it.
    public var detail: String { duckName.map { "\(state.label) · \($0)" } ?? state.label }
}

public enum RailTasks {
    /// Blocked first (the one state that needs the person), then working, then waiting; each keeps the host's order.
    /// Done and dropped Tasks are not listed. The Duck is the one the Task was handed to, else the one routing chose.
    public static func rows(_ tasks: [RoomTask], threads: [RoomThread]) -> [RailTaskRow] {
        let order: [RoomTaskState] = [.blocked, .working, .waiting]
        return order.flatMap { state in
            tasks.filter { $0.state == state }.map { task in
                let thread = duck(for: task, threads: threads)
                let name = thread.map { ($0.name ?? "").isEmpty ? $0.title : ($0.name ?? $0.title) }
                return RailTaskRow(id: task.id, title: task.title, state: state, duckName: name,
                                   duckSessionId: thread?.sessionId ?? task.handedTo?.sessionId)
            }
        }
    }

    private static func duck(for task: RoomTask, threads: [RoomThread]) -> RoomThread? {
        if let sid = task.handedTo?.sessionId, let t = threads.first(where: { $0.sessionId == sid }) { return t }
        if task.routing?.kind == "duck", let id = task.routing?.duckId, let t = threads.first(where: { $0.duckId == id }) { return t }
        return nil
    }

    public static let emptyLine = "No Task is waiting, working or blocked."
}
