import Foundation

// DESIGN.md §8.10, the Files tab's "Contents" mode: `git grep -n -I --untracked` (tracked and untracked, binary
// and ignored files left out), else `grep -rIn`. Parsing and the cap are pure; the process is run off the main actor.

public struct ContentHit: Hashable, Sendable, Identifiable {
    public var path: String
    public var line: Int
    public var snippet: String
    public var id: String { "\(path):\(line)" }
    public init(path: String, line: Int, snippet: String) { self.path = path; self.line = line; self.snippet = snippet }
}

public enum ContentSearch {
    public static let cap = 200
    public static let minimumQuery = 2
    static let snippetLimit = 200

    /// "path:12:text" (git grep, grep -rn); a leading "./" is dropped. nil for anything else, and for `.git/`.
    public static func parseLine(_ raw: String) -> ContentHit? {
        var s = Substring(raw)
        if s.hasPrefix("./") { s = s.dropFirst(2) }
        // The first ":<digits>:" in the line; a path with a colon and digits after it would be misread, which is rare.
        var search = s.startIndex
        while let colon = s[search...].firstIndex(of: ":") {
            let digitsStart = s.index(after: colon)
            var end = digitsStart
            while end < s.endIndex, s[end].isNumber, s[end].isASCII { end = s.index(after: end) }
            if end > digitsStart, end < s.endIndex, s[end] == ":", let line = Int(s[digitsStart..<end]) {
                let path = String(s[s.startIndex..<colon])
                guard !path.isEmpty, !path.hasPrefix(".git/"), !path.hasPrefix("/") else { return nil }
                let text = s[s.index(after: end)...].trimmingCharacters(in: .whitespaces)
                return ContentHit(path: path, line: line, snippet: String(text.prefix(snippetLimit)))
            }
            search = s.index(after: colon)
        }
        return nil
    }

    /// Every hit in the output, at most `cap`.
    public static func parse(_ output: String, cap: Int = ContentSearch.cap) -> [ContentHit] {
        var hits: [ContentHit] = []
        for line in output.split(whereSeparator: \.isNewline) {
            if let hit = parseLine(String(line)) { hits.append(hit); if hits.count >= cap { break } }
        }
        return hits
    }

    /// The query as a person typed it, or nil when it is too short to search for.
    public static func normalized(_ query: String) -> String? {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return q.count >= minimumQuery ? q : nil
    }

    /// Runs the search (blocking: call it off the main actor). Stops reading, and ends the process, once `cap` hits
    /// are in or `isCancelled` says so.
    public static func run(root: String, query: String, cap: Int = ContentSearch.cap, isCancelled: @Sendable () -> Bool) -> [ContentHit] {
        guard let q = normalized(query) else { return [] }
        let git = ["-C", root, "grep", "-n", "-I", "-i", "-F", "--untracked", "--no-color", "-e", q]
        if let hits = exec("/usr/bin/git", git, cap: cap, isCancelled: isCancelled) { return hits }
        let grep = ["-rIn", "-i", "-F", "--exclude-dir=.git", "--exclude-dir=node_modules", "-e", q, "."]
        return exec("/usr/bin/grep", grep, cap: cap, isCancelled: isCancelled, cwd: root) ?? []
    }

    /// nil when the tool cannot run or fails (not a repository); status 1 is "no match".
    private static func exec(_ tool: String, _ args: [String], cap: Int, isCancelled: @Sendable () -> Bool, cwd: String? = nil) -> [ContentHit]? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        var buffer = Data(), hits: [ContentHit] = [], stopped = false
        let handle = out.fileHandleForReading
        while !stopped {
            let chunk = handle.availableData
            if chunk.isEmpty { break }
            buffer.append(chunk)
            while let nl = buffer.firstIndex(of: 10) {
                let lineData = buffer[buffer.startIndex..<nl]
                buffer.removeSubrange(buffer.startIndex...nl)
                if let line = String(data: lineData, encoding: .utf8), let hit = parseLine(line) { hits.append(hit) }
                if hits.count >= cap { stopped = true; break }
            }
            if isCancelled() { stopped = true }
        }
        if stopped, p.isRunning { p.terminate() }
        p.waitUntilExit()
        if stopped { return isCancelled() ? [] : hits }
        return p.terminationStatus == 0 || p.terminationStatus == 1 ? hits : nil
    }
}
