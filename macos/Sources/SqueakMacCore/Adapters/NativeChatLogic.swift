import Foundation

// The logic behind a native chat's controls in the Mac workbench, kept out of the views so it is tested:
// permission modes, the cards an open request becomes, what a card's answer sends, and the live state a
// chat's event stream builds. Nothing here talks to the host.

/// Squeak's permission modes onto the host's strings, and the ⇧⇥ cycle.
public enum NativeModes {
    public static func composerMode(_ permissionMode: String) -> ComposerMode {
        switch permissionMode {
        case "acceptEdits", "auto": .acceptEdits
        case "plan": .plan
        case "bypassPermissions": .skipApprovals
        default: .ask
        }
    }

    public static func permissionMode(_ mode: ComposerMode) -> String {
        switch mode {
        case .ask: "default"
        case .acceptEdits: "acceptEdits"
        case .plan: "plan"
        case .skipApprovals: "bypassPermissions"
        }
    }

    /// Ask, Accept edits, Plan, then Ask again. Skip approvals is only chosen from the menu, and ⇧⇥ leaves it for Ask.
    public static func next(after mode: ComposerMode) -> ComposerMode {
        switch mode {
        case .ask: .acceptEdits
        case .acceptEdits: .plan
        case .plan, .skipApprovals: .ask
        }
    }

    public static let menu: [ComposerMode] = [.ask, .acceptEdits, .plan, .skipApprovals]
    public static let skipWarning = "Skip approvals lets the agent run every command and edit without asking."

    /// Approving a plan leaves plan mode for Accept edits, unless the person already moved the chat elsewhere.
    public static func modeAfterPlanApproval(current: String) -> String? {
        current == "plan" ? "acceptEdits" : nil
    }
}

/// What an open request is, as the card draws it.
public struct NativeCard: Equatable, Sendable, Identifiable {
    public enum Kind: Equatable, Sendable { case approval, plan, question }
    public var id: String
    public var kind: Kind
    public var approval: ApprovalCardModel?
    public var plan: PlanCardModel?
    public var question: QuestionCardModel?
    /// Every question of an AskUserQuestion, in order (`question` is the first).
    public var questionModels: [QuestionCardModel] = []
    /// The question's own words per question, the keys of the `answers` the agent reads.
    public var questionTexts: [String]
    public var multiSelect: Bool
}

public enum NativeCards {
    public static let keepPlanningMessage = "Keep planning; don't make changes yet."

    /// The oldest open request is the one the agent waits on.
    public static func card(for requests: [NativeRequest], agent: String, now: Date = Date()) -> NativeCard? {
        requests.min { ($0.createdAt ?? .distantFuture) < ($1.createdAt ?? .distantFuture) }.map { card($0, agent: agent, now: now) }
    }

    public static func card(_ r: NativeRequest, agent: String, now: Date = Date()) -> NativeCard {
        let age = shortAge(r.createdAt, now: now)
        let p = r.payload
        let tool = p["toolName"]?.string
        let input = p["input"] ?? .null
        func empty(_ k: NativeCard.Kind) -> NativeCard { NativeCard(id: r.id, kind: k, approval: nil, plan: nil, question: nil, questionTexts: [], multiSelect: false) }

        if r.kind == "plan" || tool == "ExitPlanMode" {
            var c = empty(.plan)
            let text = input["plan"]?.string ?? p["plan"]?.string ?? ""
            c.plan = PlanCardModel(title: "\(agent)'s plan", steps: [], age: age, markdown: text)
            return c
        }
        if r.kind == "question" || tool == "AskUserQuestion" {
            var c = empty(.question)
            let qs = (input["questions"]?.array ?? []).filter { $0["question"]?.string != nil }
            let first = qs.first
            c.questionModels = qs.map { q in
                let options = (q["options"]?.array ?? []).compactMap { o -> QuestionCardModel.Option? in
                    guard let label = o["label"]?.string else { return nil }
                    let rec = label.lowercased().hasSuffix("(recommended)")
                    let title = rec ? String(label.dropLast("(recommended)".count)).trimmingCharacters(in: .whitespaces) : label
                    return .init(title: title, detail: o["description"]?.string.flatMap { $0.isEmpty ? nil : $0 }, recommended: rec)
                }
                return QuestionCardModel(question: q["question"]?.string ?? "", options: options, age: age)
            }
            c.question = c.questionModels.first ?? QuestionCardModel(question: "\(agent) has a question", options: [], age: age)
            c.questionTexts = qs.compactMap { $0["question"]?.string }
            c.multiSelect = first?["multiSelect"]?.bool == true
            return c
        }
        var c = empty(.approval)
        let reason = clean(p["description"]?.string) ?? clean(input["description"]?.string) ?? clean(p["reason"]?.string)
        switch r.kind {
        case "command":
            let cmd = NativeTranscript.codexCommand(p["command"]?.string ?? "")
            c.approval = ApprovalCardModel(tool: "Command", heading: "Run a command", command: cmd.isEmpty ? nil : cmd, reason: reason, age: age)
        case "file_change":
            c.approval = ApprovalCardModel(tool: "File change", heading: clean(p["title"]?.string) ?? "Change files", target: clean(p["grantRoot"]?.string), reason: reason, age: age)
        default:
            let name = tool ?? "a tool"
            let heading = clean(p["title"]?.string) ?? "\(agent) wants to use \(name)"
            let command = name == "Bash" ? clean(input["command"]?.string) : nil
            let target = command == nil
                ? (clean(p["blockedPath"]?.string) ?? clean(input["file_path"]?.string) ?? clean(input["notebook_path"]?.string)
                    ?? clean(input["url"]?.string) ?? clean(input["pattern"]?.string))
                : nil
            c.approval = ApprovalCardModel(tool: name.hasPrefix("mcp__") ? "MCP" : name, heading: heading, command: command, target: target, reason: reason, age: age)
        }
        return c
    }

    private static func clean(_ s: String?) -> String? {
        guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        return t
    }

    /// "now", "2m", "3h", "2d".
    public static func shortAge(_ at: Date?, now: Date) -> String? {
        guard let at else { return nil }
        let s = max(0, Int(now.timeIntervalSince(at)))
        if s < 45 { return "just now" }
        if s < 3600 { return "\(max(1, s / 60))m ago" }
        if s < 86_400 { return "\(s / 3600)h ago" }
        return "\(s / 86_400)d ago"
    }
}

/// A question card's answers, collected one question at a time (an AskUserQuestion can carry several).
public struct NativeQuestionFlow: Equatable, Sendable {
    public private(set) var index = 0
    public private(set) var answers: [String: String] = [:]
    public let texts: [String]

    public init(texts: [String]) { self.texts = texts }

    public var isComplete: Bool { index >= texts.count }

    /// Records the choice (an option's label, or the person's own words); true once every question has one.
    @discardableResult
    public mutating func answer(_ value: String) -> Bool {
        guard index < texts.count else { return true }
        answers[texts[index]] = value
        index += 1
        return isComplete
    }

    public var json: NativeJSON { .object(answers.mapValues { .string($0) }) }
}

// MARK: Live state

/// What a chat's event stream says right now, built event by event. Persisted messages are the transcript's
/// business (the app rereads it when one lands); this holds what is only on the wire: the streaming text, the
/// open requests, the status.
public struct NativeLiveState: Equatable, Sendable {
    public private(set) var status: String?
    public private(set) var requests: [NativeRequest] = []
    /// The agent's message as it is being written; cleared when the persisted message arrives.
    public private(set) var streamingText = ""
    public private(set) var lastSeq = 0
    public private(set) var queueDirty = false
    /// What the app should do after applying an event.
    public enum Effect: Equatable, Sendable { case none, transcriptChanged, refetch }

    public init() {}

    public mutating func apply(_ event: NativeEvent) -> Effect {
        switch event {
        case .message(let m):
            // A replay after a reconnect repeats rows: only a new seq counts.
            guard m.seq > lastSeq else { return .none }
            lastSeq = m.seq
            if m.role == "agent", m.kind == "assistant" || m.kind == "item/agentMessage" { streamingText = "" }
            if m.role == "user" { streamingText = "" }
            return .transcriptChanged
        case .delta(let j):
            if let t = Self.deltaText(j) { streamingText += t }
            else if Self.startsBlock(j) { streamingText = "" }
            return .none
        case .status(let s):
            status = s
            if s != "working" { streamingText = "" }
            return .none
        case .request(let r):
            if !requests.contains(where: { $0.id == r.id }) { requests.append(r) }
            return .none
        case .requestResolved(let id):
            requests.removeAll { $0.id == id }
            return .none
        case .queueChanged:
            queueDirty = true
            return .none
        case .reset:
            // The replay that follows is every message again.
            lastSeq = 0
            streamingText = ""
            return .refetch
        }
    }

    public mutating func takeQueueDirty() -> Bool { defer { queueDirty = false }; return queueDirty }

    /// Claude: `stream_event` / `content_block_delta` / `text_delta`. Codex: `item/agentMessage/delta` with `delta`.
    static func deltaText(_ j: NativeJSON) -> String? {
        if j["method"]?.string == "item/agentMessage/delta" { return j["delta"]?.string }
        guard j["type"]?.string == "stream_event", let e = j["event"], e["type"]?.string == "content_block_delta",
              e["delta"]?["type"]?.string == "text_delta" else { return nil }
        return e["delta"]?["text"]?.string
    }

    /// Claude's new message or new content block: what was streaming belongs to the one before.
    static func startsBlock(_ j: NativeJSON) -> Bool {
        guard j["type"]?.string == "stream_event" else { return false }
        let t = j["event"]?["type"]?.string
        return t == "message_start" || t == "content_block_start"
    }
}

public enum NativeQueueNote {
    /// The host's 409 for a Claude chat, in the app's words.
    public static func steerRefused(_ reason: String, agent: String) -> String {
        reason.lowercased().contains("can't steer")
            ? "\(agent) can't steer mid-turn; it reads this after the turn."
            : reason
    }
}

// MARK: New chat

public enum NativeWhere: Equatable, Sendable {
    case newWorkspace
    case existing(String)
    case projectFolder
}

/// The New chat sheet's native side: project, where, agent, model, permission mode, first message.
public struct NativeNewChatForm: Equatable, Sendable {
    public var projects: [NativeProject] = []
    public private(set) var projectId: String?
    public var place: NativeWhere = .newWorkspace
    public private(set) var workspaces: [NativeWorkspace] = []
    public var agent: NewChatAgent = .claude
    public private(set) var modelId: String?
    public private(set) var effort: String?
    public var mode: ComposerMode = .ask
    public var text = ""
    public private(set) var models: [DaemonChatModel] = []

    public init() {}

    public var project: NativeProject? { projects.first { $0.id == projectId } }
    public var agentModels: [DaemonChatModel] { models.filter { $0.agent == agent.rawValue } }
    public var chosenModel: DaemonChatModel? { agentModels.first { $0.id == modelId } }
    public var trimmedText: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    public mutating func setProjects(_ list: [NativeProject], select id: String? = nil) {
        projects = list
        if let id, list.contains(where: { $0.id == id }) { projectId = id }
        else if project == nil { projectId = list.first?.id }
        workspaces = []
        if case .existing = place { place = .newWorkspace }
    }

    public mutating func choose(project id: String) {
        guard projects.contains(where: { $0.id == id }), id != projectId else { return }
        projectId = id
        workspaces = []
        if case .existing = place { place = .newWorkspace }
    }

    public mutating func setWorkspaces(_ list: [NativeWorkspace]) {
        workspaces = list.filter { $0.state != "archived" }
        if case .existing(let id) = place, !workspaces.contains(where: { $0.id == id }) { place = .newWorkspace }
    }

    public mutating func setModels(_ list: [DaemonChatModel]) {
        models = list
        reconcileModel()
    }

    public mutating func choose(agent a: NewChatAgent) { agent = a; modelId = nil; effort = nil; reconcileModel() }

    public mutating func pick(modelId id: String) {
        guard let m = agentModels.first(where: { $0.id == id }) else { return }
        modelId = m.id
        if let e = effort, m.levels.contains(e) {} else { effort = m.levels.isEmpty ? nil : (m.defaultLevel ?? m.levels.first) }
    }

    public mutating func pick(effort e: String) { effort = e }

    private mutating func reconcileModel() {
        if let id = modelId, agentModels.contains(where: { $0.id == id }) { return }
        if let first = agentModels.first { pick(modelId: first.id) } else { modelId = nil; effort = nil }
    }

    /// The branch a new workspace will take its name from is the host's to choose: the form only says it is new.
    public var canStart: Bool {
        guard project != nil, modelId != nil, !trimmedText.isEmpty, trimmedText.count <= NewChatForm.maxLength else { return false }
        if case .existing(let id) = place { return workspaces.contains { $0.id == id } }
        return true
    }

    public var startLabel: String {
        if case .newWorkspace = place { return "Create workspace and start" }
        return "Start chat"
    }

    /// What `POST /native/sessions` takes; nil while the form is incomplete.
    public var request: NativeNewSession? {
        guard canStart, let project, let modelId else { return nil }
        var spec = NativeNewSession(
            agent: agent.rawValue, model: modelId, permissionMode: NativeModes.permissionMode(mode), effort: effort, text: trimmedText)
        switch place {
        case .newWorkspace: spec.projectId = project.id; spec.newWorkspace = true
        case .existing(let id): spec.cwd = workspaces.first { $0.id == id }?.path; spec.projectId = project.id
        case .projectFolder: spec.cwd = project.rootPath; spec.projectId = project.id
        }
        return spec
    }
}

// MARK: Titles and times

public enum NativeTitles {
    /// A chat with no title yet, and none of its words known, is "New chat" rather than a folder or blank.
    public static func fallback(title: String?, firstMessage: String?) -> String {
        if let t = title?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty { return t }
        if let m = firstMessage?.trimmingCharacters(in: .whitespacesAndNewlines), !m.isEmpty {
            let line = m.split(separator: "\n").first.map(String.init) ?? m
            return line.count > 60 ? String(line.prefix(59)) + "…" : line
        }
        return "New chat"
    }
}
