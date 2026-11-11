import Foundation

// DESIGN.md §8.10, the transcript and the composer, decided apart from the views so CI can test it: how a
// turn's steps read as one-line tool previews, when they fold into "Worked · N steps", the elapsed words of the
// working row, the composer's state-aware placeholder and keys, and the small models the cards that need you take.

/// What a tool call is, for its icon.
public enum ToolKind: String, Sendable, Equatable {
    case read, edit, run, search, fetch, agent, plan, other
}

/// One tool call as a 28pt row: a verb in a fixed column, a target (mono; a path truncates from its start), and
/// the right-aligned meta.
public struct ToolCallPreview: Equatable, Sendable {
    public var kind: ToolKind
    public var verb: String
    public var target: String
    /// "6s", "background"; nil when nothing is known.
    public var meta: String?
    /// A started subagent's own `model` alias ("sonnet"), when its call named one; nil means the chat's model.
    public var modelAlias: String?

    public init(kind: ToolKind, verb: String, target: String, meta: String? = nil, modelAlias: String? = nil) {
        self.kind = kind; self.verb = verb; self.target = target; self.meta = meta; self.modelAlias = modelAlias
    }

    /// The model a started subagent runs on, as a name: its own alias in the catalogue, else the chat's. Nil for any
    /// other row, or when neither is known.
    public func agentModel(chatModelName: String?, in choices: [DaemonChatModel]) -> String? {
        guard kind == .agent, verb == "Start" else { return nil }
        if let alias = modelAlias, let own = ModelNames.subagentLabel(alias: alias, in: choices) { return own }
        return chatModelName.flatMap { ModelNames.nonEmpty($0) }
    }

    /// "Agent · Sonnet 5.5 Ship the daemon": one line for the accessibility label and tests.
    public func agentRowLabel(chatModelName: String?, in choices: [DaemonChatModel]) -> String {
        (["Agent"] + [agentModel(chatModelName: chatModelName, in: choices)].compactMap { $0 }).joined(separator: " · ") + " " + target
    }

    /// A path or a file name: truncated from the start. Commands and queries truncate at the end.
    public var targetIsPath: Bool { kind == .read || kind == .edit }

    /// The word the row shows: a started subagent reads "Agent" (the thing it is), everything else says what it did.
    public var shownVerb: String { kind == .agent && verb == "Start" ? "Duckling" : verb }
}

public enum ToolCallLabel {
    private static let background = " (in the background)"

    /// The daemon says a call as a person would ("Read store.ts", "Run npm test", "Search for "queue""): the first
    /// word is the verb. Anything else is a Bash description, which is a command.
    public static func preview(_ raw: String) -> ToolCallPreview {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        var meta: String?
        if text.hasSuffix(background) {
            text = String(text.dropLast(background.count))
            meta = "background"
        }
        if text.hasPrefix("Update the plan") {
            return ToolCallPreview(kind: .plan, verb: "Plan", target: "Updated the plan", meta: meta)
        }
        let parts = text.split(separator: " ", maxSplits: 1).map(String.init)
        let first = parts.first ?? ""
        let rest = parts.count > 1 ? parts[1] : ""
        switch first {
        case "Read": return ToolCallPreview(kind: .read, verb: "Read", target: rest, meta: meta)
        case "Edit", "Write": return ToolCallPreview(kind: .edit, verb: first, target: rest, meta: meta)
        case "Search":
            // "Search for "x"" and "Search the web for "x"".
            var target = rest
            for lead in ["the web for ", "for "] where target.hasPrefix(lead) { target = String(target.dropFirst(lead.count)); break }
            return ToolCallPreview(kind: .search, verb: "Search", target: target, meta: meta)
        case "Find": return ToolCallPreview(kind: .search, verb: "Find", target: rest, meta: meta)
        case "Load": return ToolCallPreview(kind: .search, verb: "Load", target: rest, meta: meta)
        case "Fetch": return ToolCallPreview(kind: .fetch, verb: "Fetch", target: rest, meta: meta)
        case "Start":
            // The host writes a model the call named as "Start [sonnet] description".
            if rest.hasPrefix("["), let close = rest.firstIndex(of: "]") {
                let alias = String(rest[rest.index(after: rest.startIndex)..<close])
                let target = rest[rest.index(after: close)...].trimmingCharacters(in: .whitespaces)
                return ToolCallPreview(kind: .agent, verb: "Start", target: target, meta: meta, modelAlias: alias.isEmpty ? nil : alias)
            }
            return ToolCallPreview(kind: .agent, verb: "Start", target: rest, meta: meta)
        case "Use": return ToolCallPreview(kind: .other, verb: "Use", target: rest, meta: meta)
        case "Notify", "Comment", "Set": return ToolCallPreview(kind: .other, verb: first, target: rest, meta: meta)
        case "Message", "Ask": return ToolCallPreview(kind: .agent, verb: first, target: rest, meta: meta)
        case "Run": return ToolCallPreview(kind: .run, verb: "Run", target: rest, meta: meta)
        default: return ToolCallPreview(kind: .run, verb: "Run", target: text, meta: meta)
        }
    }
}

/// Elapsed time in the words of the working row and the thinking line.
public enum ElapsedFormat {
    /// "8s", "1m 12s", "1h 2m"; never negative.
    public static func short(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds.rounded(.down)))
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m \(s % 60)s" }
        return "\(s / 3600)h \((s % 3600) / 60)m"
    }

    /// The running line's clock, whole seconds (it ticks once a second): "38s", "2m 38s", "1h 2m".
    public static func live(_ seconds: TimeInterval) -> String { short(seconds) }

    public static func thought(_ seconds: Int?) -> String {
        guard let seconds, seconds > 0 else { return "Thought" }
        return "Thought for \(seconds)s"
    }
}

/// What opens under a tool row when the transcript holds it. Only a native chat's does (the host stores tool output
/// and edits); Conductor's and the daemon's feeds keep none, so those rows do not expand.
/// A subagent's life: a background one runs on after the call that started it returned.
public enum SubagentState: Hashable, Sendable { case running, done, failed }

public enum ToolDetail: Hashable, Sendable {
    case output(command: String, tail: [String], succeeded: Bool?)
    case diff(path: String, lines: [InlineDiffLine])
    /// A subagent's own steps (one-line labels and notes, in order) and, once it reported, its answer.
    case subagent(steps: [String], result: String?, state: SubagentState = .done)
    /// Plain words: a message one chat sent another, a review comment.
    case text(String)
    /// The tracker an agent keeps above the composer (Squeak's update_progress tool). Never a row.
    case progress(steps: [String], current: Int?, percent: Double?, status: String?)
}

public struct InlineDiffLine: Hashable, Sendable {
    public enum Kind: Hashable, Sendable { case hunk, context, added, removed }
    public var kind: Kind
    public var number: Int?
    public var text: String
}

public enum InlineDiff {
    /// A unified diff's body as rows; header lines (`---`, `+++`, `diff`, `index`) are dropped.
    public static func parse(_ unified: String) -> [InlineDiffLine] {
        var out: [InlineDiffLine] = []
        var old = 0, new = 0
        for raw in unified.components(separatedBy: "\n") {
            if raw.hasPrefix("diff ") || raw.hasPrefix("index ") || raw.hasPrefix("--- ") || raw.hasPrefix("+++ ") { continue }
            if raw.hasPrefix("@@") {
                let nums = raw.split(whereSeparator: { !"0123456789".contains($0) }).compactMap { Int($0) }
                if nums.count >= 3 { old = nums[0]; new = nums[2] }
                out.append(InlineDiffLine(kind: .hunk, number: nil, text: raw))
            } else if raw.hasPrefix("+") {
                out.append(InlineDiffLine(kind: .added, number: new, text: String(raw.dropFirst()))); new += 1
            } else if raw.hasPrefix("-") {
                out.append(InlineDiffLine(kind: .removed, number: old, text: String(raw.dropFirst()))); old += 1
            } else if raw.hasPrefix(" ") {
                out.append(InlineDiffLine(kind: .context, number: new, text: String(raw.dropFirst()))); old += 1; new += 1
            }
        }
        return out
    }

    /// No more than this many lines show before "Show all" (the inspector holds the whole diff).
    public static let previewLines = 14

    public static func visible(_ lines: [InlineDiffLine], showAll: Bool) -> (lines: [InlineDiffLine], hidden: Int) {
        showAll || lines.count <= previewLines ? (lines, 0) : (Array(lines.prefix(previewLines)), lines.count - previewLines)
    }

    /// "+18 −2".
    public static func stat(_ lines: [InlineDiffLine]) -> (added: Int, removed: Int) {
        (lines.filter { $0.kind == .added }.count, lines.filter { $0.kind == .removed }.count)
    }
}

/// One item of a turn, between its two messages.
public enum TurnItem: Equatable, Identifiable, Sendable {
    case thinking(id: String, text: String, seconds: Int?, live: Bool)
    case tool(id: String, preview: ToolCallPreview, running: Bool, detail: ToolDetail?)

    public var id: String {
        switch self {
        case .thinking(let id, _, _, _), .tool(let id, _, _, _): id
        }
    }
}

/// A turn's steps as the transcript shows them: older ones folded into one "Worked · N steps" line, the rest listed.
public struct TurnBlock: Equatable, Sendable {
    public var folded: [TurnItem]
    public var shown: [TurnItem]

    public var isEmpty: Bool { folded.isEmpty && shown.isEmpty }

    /// "Worked · 6 steps"; nil when nothing is folded.
    public var foldTitle: String? {
        guard !folded.isEmpty else { return nil }
        return "Worked · \(folded.count) \(folded.count == 1 ? "step" : "steps")"
    }
}

public enum TurnFolding {
    /// While the turn runs, the newest steps list and any older fold; once it ends everything folds.
    public static let keepWhileWorking = 6

    /// `steps` are the daemon's current-turn steps. The person's own words, the agent's notes (they are the
    /// transcript's messages) and background reports (they are chips) are not steps here.
    public static func block(
        steps: [ActivityStep], working: Bool, keepRecent: Int = keepWhileWorking, details: [String: ToolDetail] = [:]
    ) -> TurnBlock {
        let own = steps.filter { $0.kind == "thinking" || $0.kind == "tool" }
        // A step's time is read up to the next step of any kind, so notes count for ends, not for rows.
        let timeline = steps.filter { $0.kind != "you" && $0.kind != "background" }
        var items: [TurnItem] = []
        for (n, step) in own.enumerated() {
            let id = "\(n):\(step.kind):\(step.text.prefix(24))"
            let isLast = n == own.count - 1 && timeline.last == step
            let seconds = duration(of: step, in: timeline)
            if step.kind == "thinking" {
                // A thought with no summary has nothing to expand: no row for it, except the live "Thinking…" line.
                if !hasSummary(step.text), !(isLast && working) { continue }
                items.append(.thinking(id: id, text: step.text, seconds: seconds, live: isLast && working))
            } else {
                var p = ToolCallLabel.preview(step.text)
                if p.meta == nil, let s = seconds, s >= 1, !(isLast && working) { p.meta = ElapsedFormat.short(TimeInterval(s)) }
                let detail = step.toolId.flatMap { details[$0] } ?? step.detail
                var backgroundRunning = false
                if case .subagent(_, _, .running)? = detail { backgroundRunning = true }
                items.append(.tool(id: id, preview: p, running: (isLast && working) || backgroundRunning, detail: detail))
            }
        }
        if !working { return TurnBlock(folded: items, shown: []) }
        guard items.count > keepRecent else { return TurnBlock(folded: [], shown: items) }
        return TurnBlock(folded: Array(items.dropLast(keepRecent)), shown: Array(items.suffix(keepRecent)))
    }

    /// Whether a thought has any text to show when opened.
    public static func hasSummary(_ text: String) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func duration(of step: ActivityStep, in timeline: [ActivityStep]) -> Int? {
        guard let at = step.at, let i = timeline.firstIndex(of: step), i + 1 < timeline.count, let next = timeline[i + 1].at else { return nil }
        return max(0, Int(next.timeIntervalSince(at).rounded()))
    }

    /// When the working row's clock starts: your newest message, else the turn's first step.
    public static func turnStart(messages: [ChatMessage], steps: [ActivityStep]) -> Date? {
        messages.last(where: { $0.role == .user })?.at ?? steps.compactMap(\.at).min()
    }
}

// MARK: Composer

public enum ComposerPhase: Equatable, Sendable {
    case idle, working, approval, plan, question
}

public enum RoundButtonKind: Equatable, Sendable {
    case send, queue, stop, disabled
}

public enum ComposerPrompt {
    /// The field's placeholder for the state (§8.10's table). Problems come first: the chat cannot be answered,
    /// the Mac is offline, the session host is down.
    public static func placeholder(
        agent: String, workspace: String?, phase: ComposerPhase, readOnlyReason: String? = nil,
        offline: Bool = false, hostDown: Bool = false
    ) -> String {
        if let readOnlyReason { return "Read-only: \(readOnlyReason)" }
        if hostDown { return "Squeak's session host isn't running" }
        if offline { return "Offline. Your draft is saved and is not sent automatically." }
        switch phase {
        case .idle:
            return "Tell \(agent) what to do next"
        case .working: return "Add a follow-up. \(agent) reads it after this turn"
        case .approval: return "Allow or deny above, or tell \(agent) what to do instead"
        case .plan: return "Adjust the plan, or approve it above"
        case .question: return "Answer above, or write your own answer"
        }
    }

    /// What the round button is: Stop when working with nothing typed (and a way to stop), Queue once typed.
    public static func button(phase: ComposerPhase, hasContent: Bool, canStop: Bool) -> RoundButtonKind {
        switch phase {
        case .working:
            if hasContent { return .queue }
            return canStop ? .stop : .disabled
        default: return .send
        }
    }
}

/// One key and what it does, for the line under the composer.
public struct KeyHint: Equatable, Sendable {
    public var key: String
    public var label: String
    public init(key: String, label: String) { self.key = key; self.label = label }
}

public enum ComposerHints {
    /// The live keys for a state. The line has a fixed height; a state with fewer keys leaves it empty, not shorter.
    public static func keys(phase: ComposerPhase, canStop: Bool) -> [KeyHint] {
        switch phase {
        case .working:
            var hints = [
                KeyHint(key: "↵", label: "queue"),
                KeyHint(key: "⌘↵", label: "steer"),
            ]
            if canStop { hints.append(KeyHint(key: "⌘.", label: "stop")) }
            return hints
        default:
            return [KeyHint(key: "↵", label: "send"), KeyHint(key: "⇧↵", label: "new line")]
        }
    }
}

/// "ctx 38% left": the chat's context window, from what the host says is used.
public enum ContextLeft {
    public static func text(used: Double?) -> String? {
        guard let used, used.isFinite else { return nil }
        return "ctx \(Int((100 - min(max(used, 0), 100)).rounded()))% left"
    }
}

public enum ComposerMode: String, CaseIterable, Sendable {
    case ask, acceptEdits, plan, skipApprovals

    public enum Tone: Sendable { case neutral, done, working, needsYou }

    public var word: String {
        switch self {
        case .ask: "Ask"
        case .acceptEdits: "Accept edits"
        case .plan: "Plan"
        case .skipApprovals: "Skip approvals"
        }
    }

    /// The state tokens reused, no `mode-*` tokens (§8.10): the word always says it too.
    public var tone: Tone {
        switch self {
        case .ask: .neutral
        case .acceptEdits: .done
        case .plan: .working
        case .skipApprovals: .needsYou
        }
    }

    /// Only a chat whose source takes a mode shows the chip, and only when it said which. Today that is a native
    /// chat once its host reports the mode (phase 5); no other source has one.
    public static func chip(source: SessionSource, mode: ComposerMode?) -> ComposerMode? {
        source == .squeak ? mode : nil
    }
}

// MARK: Cards that need you

/// A tool approval as the card draws it. Actions are the caller's: a nil closure there means "cannot give from here".
public struct ApprovalCardModel: Equatable, Sendable {
    public var tool: String?
    public var heading: String
    public var command: String?
    /// A file, folder or URL the tool acts on (drawn like the command, without the `$`).
    public var target: String?
    public var reason: String?
    public var age: String?

    public init(tool: String? = nil, heading: String, command: String? = nil, target: String? = nil, reason: String? = nil, age: String? = nil) {
        self.tool = tool; self.heading = heading; self.command = command; self.target = target; self.reason = reason; self.age = age
    }
}

public struct PlanCardModel: Equatable, Sendable {
    public var title: String
    public var steps: [String]
    public var files: [String]
    public var age: String?
    /// The plan as the agent wrote it; when set the card shows it rendered instead of numbered steps.
    public var markdown: String?

    public init(title: String, steps: [String], files: [String] = [], age: String? = nil, markdown: String? = nil) {
        self.title = title; self.steps = steps; self.files = files; self.age = age; self.markdown = markdown
    }
}

public struct QuestionCardModel: Equatable, Sendable {
    public struct Option: Equatable, Sendable {
        public var title: String
        public var detail: String?
        public var recommended: Bool
        public init(title: String, detail: String? = nil, recommended: Bool = false) {
            self.title = title; self.detail = detail; self.recommended = recommended
        }
    }
    public var question: String
    public var options: [Option]
    public var age: String?

    public init(question: String, options: [Option], age: String? = nil) {
        self.question = question; self.options = options; self.age = age
    }

    /// `1…9` answer an option, `0` is Other; option `n` sits at index `n - 1`.
    public func optionIndex(forKey key: Character) -> Int? {
        guard let n = key.wholeNumberValue, n >= 1, n <= min(9, options.count) else { return nil }
        return n - 1
    }

    /// From the lettered options in an agent's message.
    public init(layout: ChoiceLayout, age: String? = nil) {
        self.init(
            question: layout.question ?? "Choose one",
            options: layout.cards.map { Option(title: $0.title, detail: $0.detail, recommended: $0.isRecommended) }, age: age)
    }
}
