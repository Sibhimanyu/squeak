import Foundation

/// The composer's two pickers: `@` lists the chat's workspace files, `/` at the start lists commands.
public enum ComposerTrigger: Equatable, Sendable {
    /// `range` covers the `@` and the query, in UTF-16 offsets (what NSTextView uses).
    case mention(query: String, range: NSRange)
    case command(query: String, range: NSRange)

    public var range: NSRange {
        switch self { case .mention(_, let r), .command(_, let r): r }
    }
    public var query: String {
        switch self { case .mention(let q, _), .command(let q, _): q }
    }

    /// The trigger the caret is in, if any. `@` counts at the start or after whitespace and runs up to the caret
    /// without whitespace (so an e-mail address is never one); `/` counts only as the very first character, and
    /// only while the caret is still in that first word (a path later in the text is not a command).
    public static func detect(in text: String, caret: Int) -> ComposerTrigger? {
        let ns = text as NSString
        guard caret >= 0, caret <= ns.length else { return nil }
        var i = caret
        while i > 0 {
            let c = ns.character(at: i - 1)
            if isSpace(c) { break }
            i -= 1
        }
        guard i < caret else { return nil }
        let word = ns.substring(with: NSRange(location: i, length: caret - i))
        let range = NSRange(location: i, length: caret - i)
        if i == 0, word.hasPrefix("/") {
            return .command(query: String(word.dropFirst()), range: range)
        }
        if word.hasPrefix("@") {
            return .mention(query: String(word.dropFirst()), range: range)
        }
        return nil
    }

    private static func isSpace(_ c: unichar) -> Bool {
        c == 32 || c == 10 || c == 9 || c == 13
    }
}

/// Subsequence fuzzy matching, scored so that a match at a word or path boundary, a run of consecutive
/// letters and a short path rank first.
public enum FuzzyMatch {
    /// Nil when `query` is not a subsequence of `candidate` (case-insensitive). Higher is better.
    public static func score(_ query: String, in candidate: String) -> Int? {
        if query.isEmpty { return 0 }
        let q = Array(query.lowercased()), c = Array(candidate.lowercased())
        let original = Array(candidate)
        guard q.count <= c.count, original.count == c.count else { return nil }
        let base = c.lastIndex(of: "/").map { $0 + 1 } ?? 0
        var score = 0, qi = 0, prevMatch = -2
        for ci in 0..<c.count where qi < q.count && c[ci] == q[qi] {
            var s = 1
            if ci == prevMatch + 1 { s += 5 }
            let boundary = ci == 0 || "/-_. :".contains(c[ci - 1])
                || (original[ci].isUppercase && original[ci - 1].isLowercase)
            if boundary { s += 4 }
            if ci >= base { s += 1 }
            score += s
            prevMatch = ci
            qi += 1
        }
        guard qi == q.count else { return nil }
        // The file name matching whole beats a match scattered through folders.
        let name = String(c[base...])
        if name.hasPrefix(String(q)) { score += 12 } else if name.contains(String(q)) { score += 6 }
        return score * 4 - c.count / 8
    }

    /// The best `limit` candidates, best first; equal scores keep their input order.
    public static func rank<T>(_ query: String, _ items: [T], limit: Int, key: (T) -> String) -> [T] {
        if query.isEmpty { return Array(items.prefix(limit)) }
        var scored: [(Int, Int, T)] = []
        for (i, item) in items.enumerated() {
            if let s = score(query, in: key(item)) { scored.append((s, i, item)) }
        }
        scored.sort { $0.0 != $1.0 ? $0.0 > $1.0 : $0.1 < $1.1 }
        return scored.prefix(limit).map { $0.2 }
    }
}

public struct SlashCommand: Equatable, Sendable, Identifiable {
    public var name: String
    public var detail: String
    public var id: String { name }
    public init(name: String, detail: String = "") { self.name = name; self.detail = detail }
}

public enum SlashCommands {
    /// The commands of the session's latest `system/init` message (`slash_commands`, stored verbatim by the host).
    public static func fromInit(_ messages: [NativeMessage]) -> [SlashCommand] {
        guard let row = messages.last(where: { $0.kind == "system/init" }),
              let list = row.payload["slash_commands"]?.array else { return [] }
        return normalized(list.compactMap(\.string).map { SlashCommand(name: $0) })
    }

    /// The user's custom commands: `<cwd>/.claude/commands` then `~/.claude/commands`, a project command hiding a
    /// user one of the same name. A nested folder is a namespace (`git/pr.md` is `git:pr`).
    public static func custom(cwd: String?, home: String = NSHomeDirectory(), fileManager fm: FileManager = .default) -> [SlashCommand] {
        var dirs: [String] = []
        if let cwd, !cwd.isEmpty { dirs.append((cwd as NSString).appendingPathComponent(".claude/commands")) }
        dirs.append((home as NSString).appendingPathComponent(".claude/commands"))
        var found: [SlashCommand] = []
        for dir in dirs { scan(dir, prefix: "", depth: 0, fm, into: &found) }
        return normalized(found)
    }

    /// The init list with descriptions borrowed from same-named custom commands.
    public static func merged(_ commands: [SlashCommand], custom: [SlashCommand]) -> [SlashCommand] {
        let details = Dictionary(custom.map { ($0.name, $0.detail) }, uniquingKeysWith: { a, _ in a })
        return normalized(commands.map { c in
            c.detail.isEmpty ? SlashCommand(name: c.name, detail: details[c.name] ?? "") : c
        })
    }

    static func normalized(_ items: [SlashCommand]) -> [SlashCommand] {
        var seen = Set<String>()
        var out: [SlashCommand] = []
        for var c in items {
            while c.name.hasPrefix("/") { c.name.removeFirst() }
            guard !c.name.isEmpty, !c.name.contains(where: \.isWhitespace), seen.insert(c.name).inserted else { continue }
            out.append(c)
        }
        return out.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private static func scan(_ dir: String, prefix: String, depth: Int, _ fm: FileManager, into out: inout [SlashCommand]) {
        guard depth < 3, let names = try? fm.contentsOfDirectory(atPath: dir) else { return }
        for file in names.sorted() where !file.hasPrefix(".") {
            let path = (dir as NSString).appendingPathComponent(file)
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: path, isDirectory: &isDir) else { continue }
            if isDir.boolValue {
                scan(path, prefix: prefix + file + ":", depth: depth + 1, fm, into: &out)
            } else if file.hasSuffix(".md") {
                let name = prefix + String(file.dropLast(3))
                out.append(SlashCommand(name: name, detail: firstLine(path)))
            }
        }
    }

    /// `description:` from front matter, else the first non-empty line without markdown heading marks.
    static func firstLine(_ path: String) -> String {
        guard let handle = FileHandle(forReadingAtPath: path) else { return "" }
        defer { try? handle.close() }
        let data = handle.readData(ofLength: 4096)
        let text = String(decoding: data, as: UTF8.self)
        var lines = text.split(separator: "\n", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        if lines.first == "---", let end = lines.dropFirst().firstIndex(of: "---") {
            for l in lines[1..<end] where l.lowercased().hasPrefix("description:") {
                let v = l.dropFirst("description:".count).trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: "\"'")))
                if !v.isEmpty { return v }
            }
            lines = Array(lines[(end + 1)...])
        }
        for l in lines where !l.isEmpty {
            return l.trimmingCharacters(in: CharacterSet(charactersIn: "# ")).prefix(120).description
        }
        return ""
    }
}

/// Workspace files for `@`: `git ls-files --cached --others --exclude-standard` in the folder, cached per folder
/// for 30 s, capped at 20k entries.
public actor WorkspaceFileIndex {
    public static let shared = WorkspaceFileIndex()
    public static let cap = 20_000
    public static let ttl: TimeInterval = 30

    private var cache: [String: (at: Date, files: [String])] = [:]
    private let now: @Sendable () -> Date
    private let list: @Sendable (String) async -> [String]

    public init(now: @escaping @Sendable () -> Date = { Date() },
                list: @escaping @Sendable (String) async -> [String] = { WorkspaceFileIndex.gitList(in: $0) }) {
        self.now = now; self.list = list
    }

    public func files(in folder: String) async -> [String] {
        if let hit = cache[folder], now().timeIntervalSince(hit.at) < Self.ttl { return hit.files }
        let files = Array(await list(folder).prefix(Self.cap))
        cache[folder] = (now(), files)
        return files
    }

    /// Output lines to paths: blank lines dropped, a directory-ish or duplicate entry (a submodule listed twice by
    /// --cached and --others) skipped.
    public static func parse(_ output: String) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for line in output.split(separator: "\n") where !line.isEmpty {
            let path = String(line)
            if seen.insert(path).inserted { out.append(path) }
            if out.count >= cap { break }
        }
        return out
    }

    public static func gitList(in folder: String) -> [String] {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: folder, isDirectory: &isDir), isDir.boolValue else { return [] }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", folder, "ls-files", "-z", "--cached", "--others", "--exclude-standard"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return [] }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { return [] }
        return parse(String(decoding: data, as: UTF8.self).replacingOccurrences(of: "\0", with: "\n"))
    }
}
