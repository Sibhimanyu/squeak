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

/// The lower part holds the terminal only (Setup and Run left this panel; the scripts live in Settings). Kept as an
/// enum so a tab saved by an older build (`setup`, `run`) still decodes, and falls back to the terminal.
public enum InspectorLowerTab: String, CaseIterable, Identifiable, Sendable {
    case terminal
    public var id: String { rawValue }
    public var title: String { "Terminal" }

    public static func available(native: Bool) -> [InspectorLowerTab] { [.terminal] }

    /// The saved tab if it still exists, else the terminal.
    public static func restored(_ raw: String, native: Bool) -> InspectorLowerTab { .terminal }

    /// A shell tab's label in the row: "Terminal", "Terminal 2", ...
    public static func terminalTitle(number: Int) -> String { number > 1 ? "Terminal \(number)" : "Terminal" }
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
