import Foundation

/// DESIGN.md §8.10, the right panel, split in two (owner's correction 2026-11-09, the target's tab modularity).
/// The upper part's tabs: All files, Changes (with its count), Review. Decided apart from the views so CI can test
/// them. Checks left the tab row: the pull request and its checks open from the git dropdown (`GitCluster`).
public enum InspectorTab: String, CaseIterable, Identifiable, Sendable {
    case files, changes, review
    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .files: "All files"
        case .changes: "Changes"
        case .review: "Review"
        }
    }

    /// Every chat gets all three.
    public static func available(native: Bool) -> [InspectorTab] { allCases }

    /// A tab saved by an older build (`checks`, `setup`, `run`) opens Changes.
    public static func restored(_ raw: String) -> InspectorTab { InspectorTab(rawValue: raw) ?? .changes }
}

/// The lower part's tabs, under the upper part (⌘J shows and hides it): Setup and Run belong to a workspace Squeak's
/// host runs; the terminal is every chat's, and moved here from the bottom panel.
public enum InspectorLowerTab: String, CaseIterable, Identifiable, Sendable {
    case setup, run, terminal
    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .setup: "Setup"
        case .run: "Run"
        case .terminal: "Terminal"
        }
    }

    public var needsHostWorkspace: Bool { self != .terminal }

    public static func available(native: Bool) -> [InspectorLowerTab] { native ? allCases : [.terminal] }

    /// The saved tab if this chat has it, else the terminal.
    public static func restored(_ raw: String, native: Bool) -> InspectorLowerTab {
        let tab = InspectorLowerTab(rawValue: raw) ?? .terminal
        return available(native: native).contains(tab) ? tab : .terminal
    }
}

/// The Changes list as the target draws it: the folder dimmed, the file name bright; a search that filters by path;
/// a list or a tree (grouped by folder).
public enum ChangeListing {
    /// "agent-plugin/skills/squeak/" and "SKILL.md"; the folder keeps its trailing slash, "" at the root.
    public static func split(_ path: String) -> (folder: String, name: String) {
        guard let slash = path.lastIndex(of: "/") else { return ("", path) }
        return (String(path[...slash]), String(path[path.index(after: slash)...]))
    }

    /// The files whose path contains `query` (case-insensitive, every word); all of them for a blank query.
    public static func filter(_ files: [DaemonChanges.File], query: String) -> [DaemonChanges.File] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return files }
        return files.filter { f in let p = f.path.lowercased(); return words.allSatisfy { p.contains($0) } }
    }

    /// "850 files changed", "1 file changed".
    public static func header(count: Int) -> String { "\(count) \(count == 1 ? "file" : "files") changed" }
}
