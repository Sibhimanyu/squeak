import Foundation

/// What an agent is doing in its current turn, read from its transcript: the
/// thinking it chose to show, the notes between steps, and each tool call as a
/// short label ("Edit radar.ts"), never its raw input. Port of
/// `src/fleet/activity.ts`. Only the last 256 KB of the file is read.
public struct ActivityFeed: Hashable, Sendable {
    /// Oldest first, the newest `limit` of the turn.
    public var steps: [ActivityStep]
    /// How many steps the turn has had in all.
    public var total: Int
}

public enum ActivityAgent: Sendable { case claude, codex }

public struct ClaudeActivityReader: Sendable {
    public static let defaultLimit = 14
    public static let tailBytes = 256 * 1024
    static let maxStepChars = 280

    public let projectsDir: String
    public let codexSessionsDir: String

    public init(
        projectsDir: String = NSString(string: "~/.claude/projects").expandingTildeInPath,
        codexSessionsDir: String = NSString(string: "~/.codex/sessions").expandingTildeInPath
    ) {
        self.projectsDir = projectsDir
        self.codexSessionsDir = codexSessionsDir
    }

    // MARK: Locating transcripts

    /// `~/.claude/projects/<slugified-cwd>/<session-id>.jsonl`. The slug rule is
    /// not reproduced (the Node observer does not either): every project folder
    /// is scanned for the session's own file name.
    public func claudeTranscriptPath(sessionId: String) -> String? {
        guard !sessionId.isEmpty, !sessionId.contains("/") else { return nil }
        let fm = FileManager.default
        guard let dirs = try? fm.contentsOfDirectory(atPath: projectsDir) else { return nil }
        var best: (path: String, mtime: Date)?
        for dir in dirs {
            let candidate = "\(projectsDir)/\(dir)/\(sessionId).jsonl"
            guard let attrs = try? fm.attributesOfItem(atPath: candidate) else { continue }
            let mtime = (attrs[.modificationDate] as? Date) ?? .distantPast
            if best == nil || mtime > best!.mtime { best = (candidate, mtime) }
        }
        return best?.path
    }

    /// `rollout-<timestamp>-<thread id>.jsonl` under `~/.codex/sessions/YYYY/MM/DD`.
    public func codexRolloutPath(threadId: String) -> String? {
        guard !threadId.isEmpty else { return nil }
        let fm = FileManager.default
        guard let walker = fm.enumerator(atPath: codexSessionsDir) else { return nil }
        for case let rel as String in walker where rel.hasSuffix(".jsonl") && rel.contains(threadId) {
            return "\(codexSessionsDir)/\(rel)"
        }
        return nil
    }

    // MARK: Reading

    public func activity(agent: ActivityAgent, transcriptPath: String, limit: Int = defaultLimit) -> ActivityFeed {
        let entries = Self.parseJsonLines(Self.readTailLines(path: transcriptPath))
        let steps = agent == .claude ? Self.claudeSteps(entries) : Self.codexSteps(entries)
        return ActivityFeed(steps: Array(steps.suffix(limit)), total: steps.count)
    }

    /// Activity for a Conductor chat: Claude chats by `claude_session_id`, Codex by thread id.
    public func activity(agentType: String?, agentSessionId: String?, limit: Int = defaultLimit) -> ActivityFeed {
        guard let id = agentSessionId, !id.isEmpty else { return ActivityFeed(steps: [], total: 0) }
        if agentType == "codex" {
            guard let path = codexRolloutPath(threadId: id) else { return ActivityFeed(steps: [], total: 0) }
            return activity(agent: .codex, transcriptPath: path, limit: limit)
        }
        guard let path = claudeTranscriptPath(sessionId: id) else { return ActivityFeed(steps: [], total: 0) }
        return activity(agent: .claude, transcriptPath: path, limit: limit)
    }

    // MARK: File tail

    static func readTailLines(path: String, maxBytes: Int = tailBytes) -> [Data] {
        guard let handle = FileHandle(forReadingAtPath: path) else { return [] }
        defer { try? handle.close() }
        guard let size = try? handle.seekToEnd() else { return [] }
        let length = min(UInt64(maxBytes), size)
        let start = size - length
        guard (try? handle.seek(toOffset: start)) != nil,
              let data = try? handle.read(upToCount: Int(length)) else { return [] }
        var lines = data.split(separator: 0x0A, omittingEmptySubsequences: false).map { Data($0) }
        // The first line is a fragment unless we started at byte zero.
        if start > 0, !lines.isEmpty { lines.removeFirst() }
        return lines.filter { line in line.contains { $0 != 0x20 && $0 != 0x09 && $0 != 0x0D } }
    }

    static func parseJsonLines(_ lines: [Data]) -> [[String: Any]] {
        lines.compactMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    }

    // MARK: JSON helpers (same semantics as tail.ts: blank strings count as absent)

    static func str(_ v: Any?) -> String? {
        guard let s = v as? String, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return s
    }
    static func rec(_ v: Any?) -> [String: Any]? { v as? [String: Any] }
    static func arr(_ v: Any?) -> [Any] { v as? [Any] ?? [] }

    // MARK: Claude

    /// Insertion-ordered map where re-setting a key keeps its original position (like a JS `Map`).
    private struct StepMap {
        var keys: [String] = []
        var values: [String: ActivityStep] = [:]
        var count: Int { keys.count }
        mutating func set(_ key: String, _ step: ActivityStep) {
            if values[key] == nil { keys.append(key) }
            values[key] = step
        }
        mutating func reset() { keys = []; values = [:] }
        var ordered: [ActivityStep] { keys.compactMap { values[$0] } }
    }

    static func claudeSteps(_ entries: [[String: Any]]) -> [ActivityStep] {
        // Claude Code writes each block of a message as its own entry under one
        // message id, and may write a block again as it streams, so a block is
        // keyed by what it is (tool id, or kind + text), never by position.
        var steps = StepMap()
        for entry in entries {
            if entry["isSidechain"] as? Bool == true { continue }
            let type = str(entry["type"])
            let atString = str(entry["timestamp"])
            let at = ConductorTime.date(atString)
            let message = rec(entry["message"])
            if type == "user", let message {
                if let content = message["content"] as? String {
                    // A worker reporting in is part of the turn; any other user text starts a new one.
                    if let summary = firstMatch(#"<task-notification>[\s\S]*?<summary>([^<]*)</summary>"#, in: content) {
                        steps.set("bg:\(steps.count)", ActivityStep(kind: "background", text: clip(summary.trimmingCharacters(in: .whitespacesAndNewlines)), at: at))
                    } else if !content.hasPrefix("<") {
                        steps.reset()
                    }
                } else if arr(message["content"]).contains(where: { str(rec($0)?["type"]) == "text" }) {
                    steps.reset()
                }
                continue
            }
            guard type == "assistant", let message else { continue }
            let id = str(message["id"]) ?? (atString ?? "null")
            for raw in arr(message["content"]) {
                guard let block = rec(raw), let step = claudeStep(block, at: at) else { continue }
                steps.set("\(id):\(str(block["id"]) ?? "\(step.kind):\(step.text)")", step)
            }
        }
        return steps.ordered
    }

    private static func claudeStep(_ block: [String: Any], at: Date?) -> ActivityStep? {
        switch str(block["type"]) {
        case "thinking":
            guard let t = str(block["thinking"])?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
            return ActivityStep(kind: "thinking", text: clip(t), at: at)
        case "text":
            guard let t = str(block["text"])?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
            return ActivityStep(kind: "note", text: clip(t), at: at)
        case "tool_use":
            return ActivityStep(kind: "tool", text: describeClaudeTool(str(block["name"]) ?? "tool", rec(block["input"]) ?? [:]), at: at)
        default:
            return nil
        }
    }

    /// A tool call as a person would say it, never its raw input.
    public static func describeClaudeTool(_ name: String, _ input: [String: Any]) -> String {
        let file = str(input["file_path"]) ?? str(input["notebook_path"])
        let base = file.map { ($0 as NSString).lastPathComponent }
        switch name {
        case "Bash":
            let description = str(input["description"])
            let command = firstLine(str(input["command"]) ?? "")
            let label = description ?? (command.isEmpty ? "Run a command" : "Run \(command)")
            return clip(input["run_in_background"] as? Bool == true ? "\(label) (in the background)" : label, 120)
        case "Read": return base.map { "Read \($0)" } ?? "Read a file"
        case "Edit", "MultiEdit": return base.map { "Edit \($0)" } ?? "Edit a file"
        case "Write": return base.map { "Write \($0)" } ?? "Write a file"
        case "NotebookEdit": return base.map { "Edit \($0)" } ?? "Edit a notebook"
        case "Grep": return clip("Search for \(quote(str(input["pattern"])))", 120)
        case "Glob": return clip("Find \(str(input["pattern"]) ?? "files")", 120)
        case "Agent", "Task":
            let d = str(input["description"]) ?? "a subagent"
            return clip("Start \(d)\(input["run_in_background"] as? Bool == true ? " in the background" : "")", 120)
        case "WebFetch": return "Fetch \(hostOf(str(input["url"])) ?? "a page")"
        case "WebSearch": return clip("Search the web for \(quote(str(input["query"])))", 120)
        case "TodoWrite": return "Update the plan"
        case "Skill": return clip("Use the \(str(input["skill"]) ?? "a") skill", 120)
        default:
            if name.hasPrefix("mcp__") {
                return clip("Use " + name.components(separatedBy: "__").dropFirst().joined(separator: " "), 120)
            }
            return clip("Use \(name)", 120)
        }
    }

    // MARK: Codex

    static func codexSteps(_ entries: [[String: Any]]) -> [ActivityStep] {
        var steps: [ActivityStep] = []
        for entry in entries {
            let at = ConductorTime.date(str(entry["timestamp"]))
            guard str(entry["type"]) == "response_item", let payload = rec(entry["payload"]) else { continue }
            let kind = str(payload["type"])
            if kind == "message" {
                let text = arr(payload["content"]).map { str(rec($0)?["text"]) ?? "" }.joined(separator: "\n")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if str(payload["role"]) == "user" {
                    // Codex injects its own context as user messages wrapped in tags.
                    if !text.isEmpty, !text.hasPrefix("<") { steps = [] }
                } else if str(payload["role"]) == "assistant", !text.isEmpty {
                    steps.append(ActivityStep(kind: "note", text: clip(text), at: at))
                }
            } else if kind == "reasoning" {
                let text = arr(payload["summary"]).map { str(rec($0)?["text"]) ?? "" }.joined(separator: "\n")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty { steps.append(ActivityStep(kind: "thinking", text: clip(text), at: at)) }
            } else if kind == "function_call" || kind == "custom_tool_call" || kind == "local_shell_call" {
                steps.append(ActivityStep(kind: "tool", text: describeCodexTool(payload), at: at))
            }
        }
        return steps
    }

    public static func describeCodexTool(_ payload: [String: Any]) -> String {
        let name = str(payload["name"]) ?? "tool"
        let raw = str(payload["arguments"]) ?? str(payload["input"]) ?? ""
        // Shell calls carry the command as `cmd` (a JSON string or array).
        if let cmd = firstMatch(#""cmd"\s*:\s*(\[[^\]]*\]|"(?:[^"\\]|\\.)*")"#, in: raw),
           let parsed = try? JSONSerialization.jsonObject(with: Data(cmd.utf8), options: [.fragmentsAllowed])
        {
            var command: String
            if let list = parsed as? [Any] { command = list.map { "\($0)" }.joined(separator: " ") } else { command = "\(parsed)" }
            for prefix in ["bash -lc ", "zsh -lc ", "sh -lc "] where command.hasPrefix(prefix) {
                command = String(command.dropFirst(prefix.count))
            }
            return clip("Run \(firstLine(command))", 120)
        }
        if name == "apply_patch" || raw.contains("*** Begin Patch") {
            if let file = firstMatch(#"\*\*\* (?:Update|Add) File: (.+)"#, in: raw) {
                return "Edit \((file.trimmingCharacters(in: .whitespaces) as NSString).lastPathComponent)"
            }
            return "Edit files"
        }
        return clip("Use \(name)", 120)
    }

    // MARK: Text helpers

    private static func firstMatch(_ pattern: String, in text: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let m = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              m.numberOfRanges > 1, let r = Range(m.range(at: 1), in: text) else { return nil }
        return String(text[r])
    }

    private static func firstLine(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: true)
            .map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
    }

    private static func quote(_ v: String?) -> String { v.map { "“\($0)”" } ?? "something" }

    private static func hostOf(_ url: String?) -> String? {
        guard let url, let u = URL(string: url), let host = u.host else { return nil }
        return u.port.map { "\(host):\($0)" } ?? host
    }

    static func clip(_ text: String, _ max: Int = maxStepChars) -> String {
        let flat = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard flat.count > max else { return flat }
        return String(flat.prefix(max - 1)).trimmingCharacters(in: .whitespaces) + "…"
    }
}
