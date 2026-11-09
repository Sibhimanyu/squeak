import Foundation

// DESIGN.md §8.10, the inspector's Files tab: the workspace tree. Pure logic only (ordering, hiding, flattening,
// change marks, the filter); the disk reads are in `FileDisk`.

public struct FileEntry: Hashable, Sendable, Identifiable {
    /// Relative to the workspace root, "/" separated.
    public var path: String
    public var name: String
    public var isDirectory: Bool
    public var id: String { path }

    public init(path: String, isDirectory: Bool) {
        self.path = path
        self.name = path.split(separator: "/").last.map(String.init) ?? path
        self.isDirectory = isDirectory
    }
}

public struct FileRow: Hashable, Sendable, Identifiable {
    public var entry: FileEntry
    public var depth: Int
    public var expanded: Bool
    public var ignored: Bool
    public var id: String { entry.path }
}

public enum FileTree {
    /// Folders first, then names, case-insensitively ("README" beside "readme" keeps a stable order by exact name).
    public static func order(_ entries: [FileEntry]) -> [FileEntry] {
        entries.sorted { a, b in
            if a.isDirectory != b.isDirectory { return a.isDirectory }
            let l = a.name.lowercased(), r = b.name.lowercased()
            return l == r ? a.name < b.name : l < r
        }
    }

    /// `.git` is never listed; a `.gitignore`d entry only with "Show ignored".
    public static func visible(_ entries: [FileEntry], ignored: Set<String>, showIgnored: Bool) -> [FileEntry] {
        entries.filter { $0.name != ".git" && (showIgnored || !ignored.contains($0.path)) }
    }

    /// The rows to draw: the root's children (key ""), each expanded folder's children under it. A folder that is
    /// expanded but not read yet shows no children until its listing arrives.
    public static func rows(
        children: [String: [FileEntry]], expanded: Set<String>, ignored: Set<String>, showIgnored: Bool
    ) -> [FileRow] {
        var out: [FileRow] = []
        func walk(_ dir: String, _ depth: Int) {
            let list = visible(order(children[dir] ?? []), ignored: ignored, showIgnored: showIgnored)
            for e in list {
                let open = e.isDirectory && expanded.contains(e.path)
                out.append(FileRow(entry: e, depth: depth, expanded: open, ignored: ignored.contains(e.path)))
                if open { walk(e.path, depth + 1) }
            }
        }
        walk("", 0)
        return out
    }

    public static func parent(of path: String) -> String {
        path.lastIndex(of: "/").map { String(path[..<$0]) } ?? ""
    }

    /// Every folder above a path, root first, without the root ("a", "a/b" for "a/b/c.txt").
    public static func ancestors(of path: String) -> [String] {
        let parts = path.split(separator: "/").dropLast()
        var out: [String] = [], cur = ""
        for p in parts { cur = cur.isEmpty ? String(p) : cur + "/" + p; out.append(cur) }
        return out
    }
}

/// Which files git says changed, and the folders that hold one (so a collapsed folder can say so).
public struct FileChangeMarks: Equatable, Sendable {
    public private(set) var files: [String: String] = [:]
    public private(set) var folders: Set<String> = []

    public init() {}

    public init(_ changed: [DaemonChanges.File]) {
        for f in changed {
            files[f.path] = f.status
            for a in FileTree.ancestors(of: f.path) { folders.insert(a) }
        }
    }

    /// The status letter of a file; nil for a file that did not change and for every folder.
    public func status(of entry: FileEntry) -> String? { entry.isDirectory ? nil : files[entry.path] }
    public func holdsChange(_ entry: FileEntry) -> Bool { entry.isDirectory && folders.contains(entry.path) }
}

public enum FileFilter {
    /// Paths matching every word of the query (case-insensitive, anywhere in the path), file-name matches first,
    /// then shorter paths, then alphabetical. An empty query matches nothing: the caller shows the tree.
    public static func match(_ query: String, in paths: [String], limit: Int = 200) -> [String] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return [] }
        var scored: [(path: String, rank: Int)] = []
        for p in paths {
            let lower = p.lowercased()
            guard words.allSatisfy({ lower.contains($0) }) else { continue }
            let name = (lower.split(separator: "/").last.map(String.init)) ?? lower
            let inName = words.allSatisfy { name.contains($0) }
            let prefix = words.first.map { name.hasPrefix($0) } ?? false
            scored.append((p, (inName ? 0 : 2) + (prefix ? 0 : 1)))
        }
        scored.sort { a, b in
            if a.rank != b.rank { return a.rank < b.rank }
            if a.path.count != b.path.count { return a.path.count < b.path.count }
            return a.path < b.path
        }
        return scored.prefix(limit).map(\.path)
    }
}
