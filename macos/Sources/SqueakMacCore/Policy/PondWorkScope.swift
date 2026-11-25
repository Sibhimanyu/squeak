import Foundation

// DESIGN.md 8.12: in the new layout the Room (and the Dashboard beside it) has the same slim rail and work pane as a Duck
// view, scoped to the Pond itself instead of one Duck's chat: Changes and Files of the Pond's own folder (its main
// checkout), its Artifacts (by project id), and a shell in that folder. The pane's remembered view and width are
// keyed by project id (pond identity: never by name). Pure, so the window only draws.

public struct PondWorkScope: Equatable, Sendable {
    public var key: String
    public var projectId: String
    public var name: String
    /// The Pond's own folder on this Mac.
    public var root: String

    public init(key: String, projectId: String, name: String, root: String) {
        self.key = key; self.projectId = projectId; self.name = name; self.root = root
    }

    /// The pane's key: one per Pond, by project id.
    public var paneKey: String { WorkPaneMetrics.pondKey(projectId: projectId) }

    /// The chat whose changes are the Pond folder's: a real host session working in that very folder (the main checkout),
    /// the one with the latest activity. Nil when nothing runs there, and Changes then says so instead of inventing a list.
    public func changesSession(in sessions: [HostSession]) -> HostSession? {
        let want = Self.normal(root)
        return sessions
            .filter { $0.cwd.map(Self.normal) == want }
            .max { ($0.lastActivityAt ?? .distantPast) < ($1.lastActivityAt ?? .distantPast) }
    }

    /// Whether a folder from an "open" request belongs to this Pond's own folder.
    public func owns(root other: String?) -> Bool {
        guard let other, !other.isEmpty else { return true }
        return Self.normal(other) == Self.normal(root)
    }

    private static func normal(_ path: String) -> String {
        var p = path
        while p.count > 1, p.hasSuffix("/") { p.removeLast() }
        return p
    }
}

/// Whether the work pane applies to the page on screen, and which pane key it uses.
public enum WorkPaneScopeRule {
    /// A Pond page (Dashboard or Room) shows the Pond-scoped rail in the new layout, on both pages so the width never
    /// changes when the person switches between them. A Duck view has its own scope; the classic layout has none.
    public static func pondScope(isNewLayout: Bool, onPondPage: Bool, hasLocalFolder: Bool) -> Bool {
        isNewLayout && onPondPage && hasLocalFolder
    }
}
