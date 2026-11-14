import Foundation

/// Turns the rows Squeak's session host stores (the agents' own messages, verbatim) into what the app draws:
/// the person's and the agent's words as `ChatMessage`s, the turn's steps as `ActivityStep`s, and what opens
/// under a tool row (a command's output, an edit's diff) as `ToolDetail`s keyed by the step's `toolId`.
///
/// Claude rows are SDK messages: `assistant` (one content block per row: text, thinking, tool_use), `user`
/// (tool_result blocks), `result/*`. Codex rows are app-server items: `item/agentMessage`, `item/reasoning`,
/// `item/commandExecution`, `item/fileChange`. Shapes follow what each agent's SDK and app-server emit.
public enum NativeTranscript {
    public struct Mapped: Sendable, Equatable {
        public var messages: [ChatMessage] = []
        /// In order, across every turn mapped: `you`, `note`, `thinking`, `tool`, `error`.
        public var steps: [ActivityStep] = []
        public var details: [String: ToolDetail] = [:]
        /// Each turn's own steps (thinking, notes, tool calls with their detail, errors), by the turn id its messages
        /// carry (`t<seq of the person's message>`). Steps before the first person's message in the rows read are
        /// filed under `headTurn`. This is what a finished turn shows folded under its reply.
        public var turnSteps: [String: [ActivityStep]] = [:]
    }

    /// Steps of rows that begin mid-turn (the person's message is further back than the rows read).
    public static let headTurn = ""

    /// Lines of a command's output kept for the row (the end of it: that is where the failure is).
    public static let outputTailLines = 40

    public static func map(_ rows: [NativeMessage]) -> Mapped {
        var out = Mapped()
        var turn: String?
        /// A turn has started and no row has ended it since: a steered message now joins it instead of starting another.
        var open = false
        /// When the newest `result` row ended its turn (a steer written just after it is still that chain's).
        var lastResultAt: Date?
        var tools: [String: (name: String, input: NativeJSON)] = [:]
        /// A subagent's steps and answer, under its Agent/Task call's id.
        var subagents: [String: (steps: [String], result: String?, state: SubagentState)] = [:]
        /// A background task's id (system `task_started`) to its Agent call's tool-use id.
        var taskTools: [String: String] = [:]
        func publish(_ id: String) {
            guard let e = subagents[id] else { return }
            out.details[id] = .subagent(steps: e.steps, result: e.result, state: e.state)
        }
        /// A background subagent's end: `<task-notification>` (a user entry) or a system `task_notification`.
        func finish(_ id: String, status: String?, summary: String?) {
            var e = subagents[id] ?? ([], nil, .running)
            let text = (summary ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { e.result = clip(text, 4000) }
            e.state = (status == "failed" || status == "stopped" || status == "killed" || status == "error") ? .failed : .done
            subagents[id] = e
            publish(id)
        }

        /// The person pressed Stop: Squeak's host stops the helpers with the turn, and a stopped helper never reports
        /// (a killed one's notification can be lost with the process), so none started so far is still running.
        func stopHelpers() {
            for (id, e) in subagents where e.state == .running {
                subagents[id]?.state = .failed
                publish(id)
            }
        }

        func step(_ kind: String, _ text: String, _ row: NativeMessage, toolId: String? = nil, detail: ToolDetail? = nil) {
            // The live "Retrying…" line lasts until the next step of any kind (the agent's next message, a tool, an error).
            if out.steps.last?.kind == "retry" { out.steps.removeLast() }
            let made = ActivityStep(kind: kind, text: text, at: row.createdAt, toolId: toolId, detail: detail)
            out.steps.append(made)
            // The live retry line and the progress tracker are the live turn's, not part of a turn's record.
            if kind != "retry", kind != "progress" { out.turnSteps[turn ?? headTurn, default: []].append(made) }
        }
        func subagent(_ parent: String, _ line: String) {
            var entry = subagents[parent] ?? ([], nil, .done)
            entry.steps.append(clip(line, 200))
            subagents[parent] = entry
            publish(parent)
        }
        func say(_ role: MessageRole, _ text: String, _ row: NativeMessage, suffix: Int = 0, steered: Bool? = nil) {
            let author = role == .user ? row.author?.name.trimmingCharacters(in: .whitespaces) : nil
            out.messages.append(
                ChatMessage(
                    id: suffix == 0 ? "native-\(row.seq)" : "native-\(row.seq)-\(suffix)", role: role, text: text, at: row.createdAt,
                    turnId: turn, cursor: String(row.seq), steered: steered, authorName: author.flatMap { $0.isEmpty ? nil : $0 }))
        }

        for row in rows {
            if endsTurn(row.kind) { open = false; lastResultAt = row.kind.hasPrefix("result") ? row.createdAt : nil }
            switch row.kind {
            case "user/text":
                guard let text = row.payload["text"]?.string, !text.isEmpty else { continue }
                // A background worker reporting in is part of the turn, never a message from the person.
                if let notes = notifications(in: text) {
                    for n in notes { finish(n.toolUseId, status: n.status, summary: n.summary) }
                    continue
                }
                // A message steered into a running turn belongs to it: the turn's steps, and the clock, carry on.
                let steered = row.payload["steered"]?.bool == true
                let joins = steered && turn != nil && (open || followsResult(row, at: lastResultAt))
                if !joins { turn = "t\(row.seq)" }
                open = true
                say(.user, text, row, steered: joins ? true : nil)
                step("you", text, row)

            case "assistant":
                // A subagent's own messages (parent_tool_use_id set) belong to its tool row, not to this chat.
                if let parent = row.payload["parent_tool_use_id"]?.string {
                    for block in row.payload["message"]?["content"]?.array ?? [] {
                        switch block["type"]?.string {
                        case "text":
                            if let t = block["text"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty {
                                subagent(parent, firstLine(t))
                            }
                        case "tool_use":
                            guard let id = block["id"]?.string, let name = block["name"]?.string else { continue }
                            let input = block["input"] ?? .null
                            tools[id] = (name, input)
                            subagent(parent, claudeLabel(name, input))
                        default: break
                        }
                    }
                    continue
                }
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
                        if let path = fileTarget(name, input) {
                            out.details[id] = PathLinking.isImage(URL(fileURLWithPath: path)) ? .image(path: path, caption: nil, card: false) : (name == "Read" ? .file(path: path) : claudeDiff(name, input))
                        } else if let diff = claudeDiff(name, input) { out.details[id] = diff }
                    default: break
                    }
                }

            case "system/task_started":
                if let task = row.payload["task_id"]?.string, let tool = row.payload["tool_use_id"]?.string {
                    taskTools[task] = tool
                    var e = subagents[tool] ?? ([], nil, .running)
                    if e.result == nil { e.state = .running }
                    subagents[tool] = e
                    publish(tool)
                }

            case "system/task_notification":
                if let tool = row.payload["tool_use_id"]?.string ?? row.payload["task_id"]?.string.flatMap({ taskTools[$0] }) {
                    finish(tool, status: row.payload["status"]?.string, summary: row.payload["summary"]?.string)
                }

            case "system/background_tasks_changed":
                // The live set: a task Squeak saw start that is no longer listed has ended (its report may have been lost).
                let live = Set((row.payload["tasks"]?.array ?? []).compactMap { $0["task_id"]?.string })
                for (task, tool) in taskTools where !live.contains(task) {
                    if subagents[tool]?.state == .running { subagents[tool]?.state = .done; publish(tool) }
                }

            case "user":
                // A report that arrives as a user entry (Claude Code's `<task-notification>`) is not the person's.
                let raw = row.payload["message"]?["content"]
                let asText = raw?.string ?? (raw?.array ?? []).compactMap { $0["text"]?.string }.joined(separator: "\n")
                if asText.hasPrefix("[Request interrupted by user") { stopHelpers(); continue }
                if let notes = notifications(in: asText) {
                    for n in notes { finish(n.toolUseId, status: n.status, summary: n.summary) }
                    continue
                }
                for block in row.payload["message"]?["content"]?.array ?? [] where block["type"]?.string == "tool_result" {
                    guard let id = block["tool_use_id"]?.string, let call = tools[id] else { continue }
                    let failed = block["is_error"]?.bool == true
                    if call.name == "Task" || call.name == "Agent" {
                        var entry = subagents[id] ?? ([], nil, .done)
                        let answer = resultText(block["content"]).trimmingCharacters(in: .whitespacesAndNewlines)
                        // An async launch answers at once with its id; the report comes later as a notification.
                        let launched = row.payload["tool_use_result"]?["status"]?.string == "async_launched"
                            || answer.contains("async_launched") || answer.hasPrefix("Async agent launched")
                        if launched {
                            if entry.result == nil { entry.state = .running }
                        } else if !answer.isEmpty {
                            entry.result = clip(answer, 4000)
                            entry.state = failed ? .failed : .done
                        } else if failed { entry.state = .failed }
                        subagents[id] = entry
                        publish(id)
                    } else if call.name == "Bash" {
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
                    out.details[id] = PathLinking.isImage(URL(fileURLWithPath: path))
                        ? .image(path: path, caption: nil, card: false)
                        : .diff(path: path, lines: codexDiff(kind: kind, diff: change["diff"]?.string ?? ""))
                }

            case "item/mcpToolCall", "item/dynamicToolCall":
                if let tool = row.payload["tool"]?.string {
                    let server = row.payload["server"]?.string
                    step("tool", server.map { mcpLabel(server: $0, tool: tool) } ?? "Use \(words(tool))", row, toolId: row.payload["id"]?.string)
                }

            case "item/webSearch":
                if let q = row.payload["query"]?.string { step("tool", "Search the web for \"\(clip(q, 120))\"", row, toolId: row.payload["id"]?.string) }

            case "system/error", "system/restart", "error":
                if let t = row.payload["text"]?.string ?? row.payload["content"]?.string {
                    if NativeErrorText.isStop(t) { stopHelpers() }
                    step(NativeErrorText.isStop(t) ? "note" : "error", NativeErrorText.sentence(t), row) }

            // A thread continued in a new one (both sides say so), and the host compacting a long chat by itself.
            case "system/note":
                if row.payload["linkedSessionId"] != nil || row.payload["autoCompact"] != nil, let t = row.payload["text"]?.string {
                    step("note", t, row)
                }

            case "system/api_retry":
                step("retry", NativeRetry.line(row.payload), row)

            // Squeak's own notes, written when the chat's agent used one of Squeak's tools.
            case "squeak/notify":
                let t = row.payload["text"]?.string ?? ""
                step("tool", "Notify you: \(clip(firstLine(t), 160))", row, toolId: "squeak-\(row.seq)", detail: .text(t))
            case "squeak/agent-message":
                let to = row.payload["text"]?.string ?? "Sent to a chat"
                let title = to.hasPrefix("Sent to ") ? String(to.dropFirst("Sent to ".count)) : to
                step("tool", "Message \(title)", row, toolId: "squeak-\(row.seq)", detail: (row.payload["message"]?.string).map { .text($0) })
            case "squeak/agent-started":
                let t = row.payload["text"]?.string ?? "Started a chat"
                step("tool", t.hasPrefix("Started ") ? "Start chat \(t.dropFirst("Started ".count))" : t, row, toolId: "squeak-\(row.seq)")
            case "squeak/review-comment":
                let place = "\(row.payload["file"]?.string ?? "a file"):\(row.payload["line"]?.int ?? 0)"
                step("tool", "Comment \(place)", row, toolId: "squeak-\(row.seq)", detail: (row.payload["text"]?.string).map { .text($0) })
            case "squeak/image":
                guard let path = row.payload["path"]?.string else { break }
                let name = row.payload["name"]?.string ?? basename(path)
                step("tool", "Show image \(name)", row, toolId: "squeak-\(row.seq)", detail: .image(path: path, caption: row.payload["caption"]?.string, card: true))
            case "squeak/target-branch":
                if let b = row.payload["branch"]?.string { step("tool", "Set target branch \(b)", row, toolId: "squeak-\(row.seq)") }
            case "squeak/progress":
                let steps = (row.payload["steps"]?.array ?? []).compactMap(\.string)
                step("progress", row.payload["status"]?.string ?? "", row, detail: .progress(
                    steps: steps, current: row.payload["current"]?.int, percent: row.payload["percent"]?.double,
                    status: row.payload["status"]?.string))

            default: break
            }
        }
        // A tool's output, diff or subagent arrives after its row: file each step's detail now that all rows are read.
        for (turn, steps) in out.turnSteps {
            out.turnSteps[turn] = steps.map { s in
                var s = s
                if s.detail == nil, let id = s.toolId { s.detail = out.details[id] }
                return s
            }
        }
        return out
    }

    /// The rows from the person's newest message on: the turn a working chat is in.
    public static func currentTurn(_ rows: [NativeMessage]) -> [NativeMessage]? {
        guard let i = turnStartIndices(rows).last else { return nil }
        return Array(rows[i...])
    }

    /// The rows that begin a turn: a person's message, except one steered into a turn that is still running.
    static func turnStartIndices(_ rows: [NativeMessage]) -> [Int] {
        var out: [Int] = []
        var open = false
        var lastResultAt: Date?
        for (i, row) in rows.enumerated() {
            if endsTurn(row.kind) { open = false; lastResultAt = row.kind.hasPrefix("result") ? row.createdAt : nil }
            guard row.kind == "user/text", notifications(in: row.payload["text"]?.string ?? "") == nil else { continue }
            if row.payload["steered"]?.bool == true, open || followsResult(row, at: lastResultAt), !out.isEmpty { continue }
            out.append(i)
            open = true
        }
        return out
    }

    /// How long after a `result` a steered row still belongs to the turn that result ended: the person steered while the
    /// agent was finishing, and the host wrote the row a moment after the turn-end (a chain of turns linked by steers is one
    /// visual turn). An interrupt (Stop) writes no `result`, so a steer after it starts a fresh turn.
    public static let steerChainWindow: TimeInterval = 10

    static func followsResult(_ row: NativeMessage, at ended: Date?) -> Bool {
        guard let ended, let at = row.createdAt else { return false }
        let gap = at.timeIntervalSince(ended)
        return gap >= 0 && gap <= steerChainWindow
    }

    /// A row the host writes when a turn is over (Claude's result, Codex's turn end, an abort or an error).
    static func endsTurn(_ kind: String) -> Bool {
        kind.hasPrefix("result") || kind.hasPrefix("turn/") || kind == "error" || kind == "system/error" || kind == "system/restart"
    }

    /// Whether this message opened its turn (its id is the turn's), as opposed to being steered into one. A message with no
    /// turn yet (a local echo) is a start.
    public static func startsTurn(_ m: ChatMessage) -> Bool {
        guard m.role == .user else { return false }
        guard let t = m.turnId else { return true }
        return m.id.hasPrefix("native-") && "t" + m.id.dropFirst("native-".count) == t || !m.id.hasPrefix("native-")
    }

    /// A worker's report as Claude Code writes it: `<task-notification><tool-use-id>…</tool-use-id><status>…</status><summary>…</summary>`.
    struct Notification: Equatable { var toolUseId: String; var status: String?; var summary: String? }

    /// The reports in a user entry's text, or nil when it is not one (a person's message that merely mentions the tag
    /// is not: the text must start with it).
    static func notifications(in text: String) -> [Notification]? {
        guard text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("<task-notification>") else { return nil }
        func field(_ name: String, in body: String) -> String? {
            guard let a = body.range(of: "<\(name)>"), let b = body.range(of: "</\(name)>", range: a.upperBound..<body.endIndex) else { return nil }
            return String(body[a.upperBound..<b.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        var out: [Notification] = []
        var rest = text[...]
        while let a = rest.range(of: "<task-notification>") {
            let end = rest.range(of: "</task-notification>", range: a.upperBound..<rest.endIndex)?.lowerBound ?? rest.endIndex
            let body = String(rest[a.upperBound..<end])
            if let id = field("tool-use-id", in: body) ?? field("tool_use_id", in: body) {
                out.append(Notification(toolUseId: id, status: field("status", in: body), summary: field("summary", in: body) ?? field("result", in: body)))
            }
            rest = rest[end...]
            if let close = rest.range(of: "</task-notification>") { rest = rest[close.upperBound...] } else { break }
        }
        return out
    }

    // MARK: Labels

    /// The file a Read/Write/Edit call is about, when its input names one.
    static func fileTarget(_ name: String, _ input: NativeJSON) -> String? {
        switch name {
        case "Read", "Write", "Edit", "MultiEdit": input["file_path"]?.string
        case "NotebookEdit": input["notebook_path"]?.string
        default: nil
        }
    }

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
        case "Task", "Agent":
            let own = s("model").map { "[\($0.filter { $0 != "[" && $0 != "]" })] " } ?? ""
            return "Start \(own)\(clip(s("description") ?? s("subagent_type") ?? "a duckling", 120))" + background
        case "TodoWrite": return "Update the plan"
        case "ToolSearch":
            let q = (s("query") ?? "").replacingOccurrences(of: "select:", with: "")
            return "Load tools \(clip(q.replacingOccurrences(of: ",", with: ", "), 120))"
        case "Skill": return "Use the \(s("skill") ?? s("command") ?? "a") skill"
        default:
            // mcp__server__tool_name reads as "Use server: tool name"; Squeak's own as what they do.
            if name.hasPrefix("mcp__") {
                let parts = name.dropFirst(5).components(separatedBy: "__")
                if parts.count >= 2 { return mcpLabel(server: parts[0], tool: parts.dropFirst().joined(separator: "__"), input: input) }
            }
            return "Use \(name)"
        }
    }

    static func mcpLabel(server: String, tool: String, input: NativeJSON = .null) -> String {
        if server == "squeak" {
            switch NativeStatus.normalizedTool(tool) {
            case "stream_changes": return "Read the workspace diff"
            case "list_review_notes": return "Read review comments"
            case "list_chats": return "Find other chats"
            case "read_chat": return "Read another chat"
            case "script_output": return "Read script output"
            // The rest leave a Squeak note row of their own; the call itself is the plain action.
            default: return "Use \(words(tool))"
            }
        }
        return "Use \(server): \(words(tool))"
    }

    static func words(_ tool: String) -> String { tool.replacingOccurrences(of: "_", with: " ") }

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
