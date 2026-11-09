import Foundation

/// What a chat changed against its base branch: `GET /control/session/<key>/changes`. Every field is lenient, so
/// a daemon that adds or drops one still decodes.
public struct DaemonChanges: Decodable, Sendable, Equatable {
    public struct File: Decodable, Sendable, Equatable, Identifiable {
        public var path: String
        /// "A", "M", "D" or "R".
        public var status: String
        public var added: Int
        public var removed: Int
        public var id: String { path }

        enum CodingKeys: String, CodingKey { case path, status, added, removed }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            guard let p = c.lenient(String.self, .path), !p.isEmpty else { throw AdapterError.badResponse("unreadable change") }
            path = p
            let s = c.lenient(String.self, .status) ?? "M"
            status = ["A", "M", "D", "R"].contains(s) ? s : "M"
            added = max(0, c.lenient(Int.self, .added) ?? 0)
            removed = max(0, c.lenient(Int.self, .removed) ?? 0)
        }
        public init(path: String, status: String = "M", added: Int = 0, removed: Int = 0) {
            self.path = path; self.status = status; self.added = added; self.removed = removed
        }
    }

    public var base: String?
    public var files: [File]
    public var added: Int
    public var removed: Int

    enum CodingKeys: String, CodingKey { case base, files, totals }
    enum TotalsKeys: String, CodingKey { case added, removed }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        base = c.lenient(String.self, .base)
        files = (c.lenient([Failable<File>].self, .files) ?? []).compactMap(\.value)
        let t = try? c.nestedContainer(keyedBy: TotalsKeys.self, forKey: .totals)
        added = t?.lenient(Int.self, .added) ?? files.reduce(0) { $0 + $1.added }
        removed = t?.lenient(Int.self, .removed) ?? files.reduce(0) { $0 + $1.removed }
    }
    public init(base: String? = nil, files: [File] = []) {
        self.base = base; self.files = files
        added = files.reduce(0) { $0 + $1.added }; removed = files.reduce(0) { $0 + $1.removed }
    }
}

/// One file's unified diff: `GET /control/session/<key>/changes/file?path=`.
public struct DaemonChangePatch: Decodable, Sendable, Equatable {
    public var path: String
    public var patch: String
    public var truncated: Bool
    enum CodingKeys: String, CodingKey { case path, patch, truncated }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = c.lenient(String.self, .path) ?? ""
        patch = c.lenient(String.self, .patch) ?? ""
        truncated = c.lenient(Bool.self, .truncated) ?? false
    }
    public init(path: String, patch: String, truncated: Bool = false) { self.path = path; self.patch = patch; self.truncated = truncated }
}

extension DaemonClient {
    /// nil when the daemon predates the route or cannot read the chat's folder (404/503); a chat with no changes is an empty list.
    public func changes(sessionKey: String) async throws -> DaemonChanges? {
        let r = try await getControl("/control/session/\(Self.encode(sessionKey))/changes")
        if r.status == 404 || r.status == 503 { return nil }
        try Self.check(r.status)
        return try decode(DaemonChanges.self, r.body)
    }

    /// nil when the file is not (or no longer) in the chat's change list.
    public func changePatch(sessionKey: String, path: String) async throws -> DaemonChangePatch? {
        let r = try await getControl("/control/session/\(Self.encode(sessionKey))/changes/file?path=\(Self.encode(path))")
        if r.status == 404 || r.status == 503 { return nil }
        try Self.check(r.status)
        return try decode(DaemonChangePatch.self, r.body)
    }
}

/// What the inspector and the header draw from the change list; pure, so tests pin it.
public enum ChangesPresentation {
    /// `6 files · +142 −38 · vs master` (the inspector's summary line); `base` loses its `origin/`.
    public static func summary(_ c: DaemonChanges) -> String {
        guard !c.files.isEmpty else { return "No changes" }
        var s = "\(c.files.count) \(c.files.count == 1 ? "file" : "files") · +\(c.added) −\(c.removed)"
        if let base = c.base, !base.isEmpty { s += " · vs \(base.hasPrefix("origin/") ? String(base.dropFirst(7)) : base)" }
        return s
    }

    public struct FolderGroup: Equatable, Sendable {
        /// "" for files at the root.
        public var folder: String
        public var files: [DaemonChanges.File]
    }

    /// The changed files grouped by folder, folders and files in name order, the root first.
    public static func byFolder(_ files: [DaemonChanges.File]) -> [FolderGroup] {
        func dir(_ p: String) -> String { p.lastIndex(of: "/").map { String(p[..<$0]) } ?? "" }
        return Dictionary(grouping: files, by: { dir($0.path) })
            .map { FolderGroup(folder: $0.key, files: $0.value.sorted { $0.path < $1.path }) }
            .sorted { $0.folder < $1.folder }
    }

    public static func fileName(_ path: String) -> String { path.split(separator: "/").last.map(String.init) ?? path }

    /// How often the inspector asks again: never while hidden; at once when the chat's activity changed.
    public static let refreshInterval: TimeInterval = 10
    public static func shouldRefresh(visible: Bool, activityChanged: Bool, lastRead: Date?, now: Date) -> Bool {
        guard visible else { return false }
        if activityChanged { return true }
        guard let lastRead else { return true }
        return now.timeIntervalSince(lastRead) >= refreshInterval
    }
}

/// One line of a unified diff, with its line numbers.
public struct DiffLine: Equatable, Sendable {
    public enum Kind: Equatable, Sendable { case hunk, context, added, removed, note }
    public var kind: Kind
    public var oldNumber: Int?
    public var newNumber: Int?
    public var text: String

    public init(kind: Kind, oldNumber: Int? = nil, newNumber: Int? = nil, text: String) {
        self.kind = kind; self.oldNumber = oldNumber; self.newNumber = newNumber; self.text = text
    }
}

public enum DiffParser {
    /// Parses a unified diff; the file header (`diff --git`, `index`, `---`, `+++`) is dropped.
    public static func lines(_ patch: String) -> [DiffLine] {
        var out: [DiffLine] = []
        var old = 0, new = 0
        var inHunk = false
        for raw in patch.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.hasPrefix("@@") {
                let n = hunkStarts(line)
                old = n.old; new = n.new; inHunk = true
                out.append(DiffLine(kind: .hunk, oldNumber: nil, newNumber: nil, text: line))
            } else if !inHunk {
                if line.hasPrefix("Binary files") || line.hasPrefix("GIT binary patch") {
                    out.append(DiffLine(kind: .note, oldNumber: nil, newNumber: nil, text: "Binary file"))
                }
            } else if line.hasPrefix("+") {
                out.append(DiffLine(kind: .added, oldNumber: nil, newNumber: new, text: String(line.dropFirst()))); new += 1
            } else if line.hasPrefix("-") {
                out.append(DiffLine(kind: .removed, oldNumber: old, newNumber: nil, text: String(line.dropFirst()))); old += 1
            } else if line.hasPrefix("\\") {
                out.append(DiffLine(kind: .note, oldNumber: nil, newNumber: nil, text: line))
            } else if line.hasPrefix(" ") {
                out.append(DiffLine(kind: .context, oldNumber: old, newNumber: new, text: String(line.dropFirst()))); old += 1; new += 1
            }
        }
        return out
    }

    /// `@@ -12,7 +12,9 @@` -> (12, 12)
    static func hunkStarts(_ header: String) -> (old: Int, new: Int) {
        let parts = header.split(separator: " ")
        func start(_ s: Substring?) -> Int {
            guard let s else { return 0 }
            return Int(s.dropFirst().split(separator: ",").first ?? "") ?? 0
        }
        return (start(parts.count > 1 ? parts[1] : nil), start(parts.count > 2 ? parts[2] : nil))
    }
}
