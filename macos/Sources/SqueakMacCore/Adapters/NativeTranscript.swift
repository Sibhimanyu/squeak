import Foundation

/// Turns the rows Squeak's session host stores (the agents' own messages, verbatim) into what the app draws:
/// the person's and the agent's words as `ChatMessage`s, the turn's steps as `ActivityStep`s, and what opens
/// under a tool row (a command's output, an edit's diff) as `ToolDetail`s keyed by the step's `toolId`.
///
/// Claude rows are SDK messages: `assistant` (one content block per row: text, thinking, tool_use), `user`
/// (tool_result blocks), `result/*`. Codex rows are app-server items: `item/agentMessage`, `item/reasoning`,
/// `item/commandExecution`, `item/fileChange`. Shapes from .context/research/spike-claude-sdk.md and spike-codex.md.
public enum NativeTranscript {
    public struct Mapped: Sendable, Equatable {
        public var messages: [ChatMessage] = []
        /// In order, across every turn mapped: `you`, `note`, `thinking`, `tool`, `error`.
        public var steps: [ActivityStep] = []
        public var details: [String: ToolDetail] = [:]
    }

    /// Lines of a command's output kept for the row (the end of it: that is where the failure is).
    public static let outputTailLines = 40

    public static func map(_ rows: [NativeMessage]) -> Mapped {
        var out = Mapped()
        var turn: String?
        var tools: [String: (name: String, input: NativeJSON)] = [:]

        func step(_ kind: String, _ text: String, _ row: NativeMessage, toolId: String? = nil) {
            out.steps.append(ActivityStep(kind: kind, text: text, at: row.createdAt, toolId: toolId))
        }
        func say(_ role: MessageRole, _ text: String, _ row: NativeMessage, suffix: Int = 0) {
            out.messages.append(
                ChatMessage(
                    id: suffix == 0 ? "native-\(row.seq)" : "native-\(row.seq)-\(suffix)", role: role, text: text, at: row.createdAt,
                    turnId: turn, cursor: String(row.seq)))
        }

        for row in rows {
            switch row.kind {
            case "user/text":
                guard let text = row.payload["text"]?.string, !text.isEmpty else { continue }
                turn = "t\(row.seq)"
                say(.user, text, row)
                step("you", text, row)

            case "assistant":
                // A subagent's own messages (parent_tool_use_id set) belong to its tool row, not to this chat.
                guard row.payload["parent_tool_use_id"]?.string == nil else { continue }
                var textBlocks = 0
                for block in row.payload["message"]?["content"]?.array ?? [] {
                    switch block["type"]?.string {
                    case "text":
                        guard let t = block["text"]?.string, !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                        say(.assistant, t, row, suffix: textBlocks)
                        textBlocks += 1
                        step("note", t, row)
                    case "thinking":
                        // The SDK sends an empty summary with a signature when thinking is not displayed.
                        if let t = block["thinking"]?.string, !t.isEmpty { step("thinking", t, row) }
                    case "tool_use":
                        guard let id = block["id"]?.string, let name = block["name"]?.string else { continue }
                        let input = block["input"] ?? .null
                        tools[id] = (name, input)
                        step("tool", claudeLabel(name, input), row, toolId: id)
                        if let diff = claudeDiff(name, input) { out.details[id] = diff }
                    default: break
                    }
                }

            case "user":
                for block in row.payload["message"]?["content"]?.array ?? [] where block["type"]?.string == "tool_result" {
                    guard let id = block["tool_use_id"]?.string, let call = tools[id] else { continue }
                    let failed = block["is_error"]?.bool == true
                    if call.name == "Bash" {
                        let command = call.input["command"]?.string ?? ""
                        out.details[id] = .output(command: command, tail: tail(resultText(block["content"])), succeeded: !failed)
                    } else if failed, out.details[id] != nil {
                        // An edit that was refused changed nothing: it has no diff to show.
                        out.details[id] = nil
                    }
                }

            case "item/agentMessage":
                guard let t = row.payload["text"]?.string, !t.isEmpty else { continue }
                say(.assistant, t, row)
                step("note", t, row)

            case "item/reasoning":
                let parts = (row.payload["summary"]?.array ?? []).compactMap(\.string)
                let text = parts.joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty { step("thinking", text, row) }

            case "item/commandExecution":
                let id = row.payload["id"]?.string ?? "row-\(row.seq)"
                let command = codexCommand(row.payload["command"]?.string ?? "")
                step("tool", command, row, toolId: id)
                let exit = row.payload["exitCode"]?.int
                let status = row.payload["status"]?.string
                let succeeded: Bool? = exit.map { $0 == 0 } ?? (status == "completed" ? true : (status == "failed" || status == "declined" ? false : nil))
                out.details[id] = .output(command: command, tail: tail(row.payload["aggregatedOutput"]?.string ?? ""), succeeded: succeeded)

            case "item/fileChange":
                let base = row.payload["id"]?.string ?? "row-\(row.seq)"
                for (n, change) in (row.payload["changes"]?.array ?? []).enumerated() {
                    guard let path = change["path"]?.string else { continue }
                    let id = n == 0 ? base : "\(base)#\(n)"
                    let kind = change["kind"]?["type"]?.string ?? change["kind"]?.string ?? "update"
                    step("tool", "\(kind == "add" ? "Write" : "Edit") \(basename(path))", row, toolId: id)
                    out.details[id] = .diff(path: path, lines: codexDiff(kind: kind, diff: change["diff"]?.string ?? ""))
                }

            case "item/mcpToolCall", "item/dynamicToolCall":
                if let tool = row.payload["tool"]?.string { step("tool", "Use \(tool)", row, toolId: row.payload["id"]?.string) }

            case "item/webSearch":
                if let q = row.payload["query"]?.string { step("tool", "Search the web for \"\(clip(q, 120))\"", row, toolId: row.payload["id"]?.string) }

            case "system/error", "system/restart":
                if let t = row.payload["text"]?.string { step("error", t, row) }

            default: break
            }
        }
        return out
    }

    /// The rows from the person's newest message on: the turn a working chat is in.
    public static func currentTurn(_ rows: [NativeMessage]) -> [NativeMessage]? {
        guard let i = rows.lastIndex(where: { $0.kind == "user/text" }) else { return nil }
        return Array(rows[i...])
    }

    // MARK: Labels

    /// A call as a person would say it, in the first-word shape `ToolCallLabel.preview` reads ("Read x.ts", "Run npm test").
    static func claudeLabel(_ name: String, _ input: NativeJSON) -> String {
        func s(_ k: String) -> String? { input[k]?.string }
        let background = input["run_in_background"]?.bool == true ? " (in the background)" : ""
        switch name {
        case "Read": return "Read \(basename(s("file_path") ?? ""))"
        case "Edit", "MultiEdit": return "Edit \(basename(s("file_path") ?? ""))"
        case "Write": return "Write \(basename(s("file_path") ?? ""))"
        case "NotebookEdit": return "Edit \(basename(s("notebook_path") ?? ""))"
        case "Bash": return clip(firstLine(s("command") ?? s("description") ?? "command"), 200) + background
        case "Grep": return "Search for \"\(clip(s("pattern") ?? "", 120))\""
        case "Glob": return "Find \(clip(s("pattern") ?? "", 120))"
        case "WebSearch": return "Search the web for \"\(clip(s("query") ?? "", 120))\""
        case "WebFetch": return "Fetch \(clip(s("url") ?? "", 160))"
        case "Task", "Agent": return "Start \(clip(s("description") ?? s("subagent_type") ?? "a helper", 120))" + background
        case "TodoWrite": return "Update the plan"
        default:
            // mcp__server__tool reads as "Use tool".
            let short = name.hasPrefix("mcp__") ? String(name.split(separator: "_", omittingEmptySubsequences: true).last ?? Substring(name)) : name
            return "Use \(short)"
        }
    }

    /// Codex runs commands through the user's shell: `/bin/bash -lc 'npm test'` is "npm test".
    static func codexCommand(_ raw: String) -> String {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        for shell in ["/bin/bash", "/bin/zsh", "/bin/sh"] {
            let lead = "\(shell) -lc "
            guard t.hasPrefix(lead) else { continue }
            var rest = String(t.dropFirst(lead.count))
            if let q = rest.first, q == "'" || q == "\"", rest.count >= 2, rest.last == q {
                rest = String(rest.dropFirst().dropLast())
            }
            return clip(firstLine(rest), 200)
        }
        return clip(firstLine(t), 200)
    }

    // MARK: Details

    /// Claude's Edit, MultiEdit and Write carry the whole change in their input.
    static func claudeDiff(_ name: String, _ input: NativeJSON) -> ToolDetail? {
        switch name {
        case "Edit":
            guard let path = input["file_path"]?.string else { return nil }
            return .diff(path: path, lines: replacement(old: input["old_string"]?.string ?? "", new: input["new_string"]?.string ?? ""))
        case "MultiEdit":
            guard let path = input["file_path"]?.string else { return nil }
            var lines: [InlineDiffLine] = []
            for e in input["edits"]?.array ?? [] {
                lines += replacement(old: e["old_string"]?.string ?? "", new: e["new_string"]?.string ?? "")
            }
            return .diff(path: path, lines: lines)
        case "Write":
            guard let path = input["file_path"]?.string else { return nil }
            let content = input["content"]?.string ?? ""
            let lines = splitLines(content).enumerated().map { InlineDiffLine(kind: .added, number: $0.offset + 1, text: $0.element) }
            return .diff(path: path, lines: lines)
        default: return nil
        }
    }

    /// Removed lines then added ones. An edit's input has no line numbers, so the rows carry none.
    static func replacement(old: String, new: String) -> [InlineDiffLine] {
        splitLines(old).map { InlineDiffLine(kind: .removed, number: nil, text: $0) }
            + splitLines(new).map { InlineDiffLine(kind: .added, number: nil, text: $0) }
    }

    /// A Codex file change: an added or deleted file's `diff` is its whole content; an update's is a unified diff.
    static func codexDiff(kind: String, diff: String) -> [InlineDiffLine] {
        if diff.contains("@@") { return InlineDiff.parse(diff) }
        let lines = splitLines(diff)
        switch kind {
        case "delete": return lines.enumerated().map { InlineDiffLine(kind: .removed, number: $0.offset + 1, text: $0.element) }
        default: return lines.enumerated().map { InlineDiffLine(kind: .added, number: $0.offset + 1, text: $0.element) }
        }
    }

    /// A tool_result's `content` is a string, or blocks of text.
    static func resultText(_ content: NativeJSON?) -> String {
        if let s = content?.string { return s }
        return (content?.array ?? []).compactMap { $0["text"]?.string }.joined(separator: "\n")
    }

    static func tail(_ output: String) -> [String] {
        var lines = output.components(separatedBy: "\n")
        while lines.last?.isEmpty == true { lines.removeLast() }
        return Array(lines.suffix(outputTailLines))
    }

    private static func splitLines(_ s: String) -> [String] {
        if s.isEmpty { return [] }
        var lines = s.components(separatedBy: "\n")
        if lines.last == "" { lines.removeLast() }
        return lines
    }

    private static func basename(_ path: String) -> String { path.split(separator: "/").last.map(String.init) ?? path }
    private static func firstLine(_ s: String) -> String { s.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? s }
    private static func clip(_ s: String, _ n: Int) -> String { s.count > n ? String(s.prefix(n - 1)) + "…" : s }
}
