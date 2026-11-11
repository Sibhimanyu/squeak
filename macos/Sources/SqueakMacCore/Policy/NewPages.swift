import Foundation

/// The three creation pages (DESIGN.md "Create"): New pond, New branch, New thread. Pure logic, nothing here acts.
public enum NewPage: Equatable, Sendable {
    case pond
    case branch(projectId: String, source: NewBranchPreset = .newFromDefault)
    /// A thread in a branch; both nil means "the most recently active branch".
    case thread(projectId: String?, workspaceId: String?)
    /// A chat in a Conductor workspace (its ticked workspace), started through the daemon.
    case conductorThread(workspaceId: String)
}

/// Which choice the New branch page opens with (the pond menu's items).
public enum NewBranchPreset: Equatable, Sendable {
    case newFromDefault
    case newFrom(base: String)
    case openBranch
    case openPullRequest
    case forIssue

    public var title: String {
        switch self {
        case .newFromDefault, .newFrom: "New stream"
        case .openBranch: "Open stream"
        case .openPullRequest: "Open pull request"
        case .forIssue: "New stream for issue"
        }
    }

    public var buttonTitle: String {
        switch self {
        case .newFromDefault, .newFrom: "Create stream"
        case .openBranch, .openPullRequest: "Open stream"
        case .forIssue: "Create stream"
        }
    }

    /// The source is fixed by the menu item the page was opened from (no "Start from" menu).
    public var namesItself: Bool {
        switch self {
        case .newFromDefault, .newFrom: false
        case .openBranch, .openPullRequest, .forIssue: true
        }
    }

    /// The start the page opens with.
    public var start: NewBranchStart {
        switch self {
        case .newFromDefault: .defaultBranch
        case .newFrom(let b): .branch(b)
        case .openBranch: .openBranch("")
        case .openPullRequest: .pullRequest("")
        case .forIssue: .issue("")
        }
    }
}

/// Where a creation was asked for.
public enum NewEntry: Equatable, Sendable {
    /// The sidebar's top "Create".
    case sidebarCreate
    /// The "+" next to a pond.
    case pondPlus(projectId: String, source: NewBranchPreset = .newFromDefault)
    /// The "+" on a branch (or the tab strip's "+").
    case branchPlus(projectId: String, workspaceId: String)
    /// ⌘N and the command palette: no place is named.
    case newThreadShortcut
    case conductorWorkspacePlus(workspaceId: String)
}

public enum NewPages {
    public static func page(for entry: NewEntry) -> NewPage {
        switch entry {
        case .sidebarCreate: .pond
        case .pondPlus(let p, let src): .branch(projectId: p, source: src)
        case .branchPlus(let p, let w): .thread(projectId: p, workspaceId: w)
        case .newThreadShortcut: .thread(projectId: nil, workspaceId: nil)
        case .conductorWorkspacePlus(let w): .conductorThread(workspaceId: w)
        }
    }
}

// MARK: New pond

public enum NewPondKind: String, CaseIterable, Sendable, Equatable {
    case folder, clone, invite

    public var title: String {
        switch self {
        case .folder: "A folder on this Mac"
        case .clone: "Clone from GitHub"
        case .invite: "Join with an invite"
        }
    }
}

public struct NewPondForm: Equatable, Sendable {
    public var kind: NewPondKind = .folder
    public var name = ""
    public private(set) var folderPath: String?
    public var cloneURL = ""
    public var inviteCode = ""
    /// The name was typed by the person: a later folder pick leaves it alone.
    private var nameEdited = false

    public init() {}

    public mutating func setName(_ text: String) { name = text; nameEdited = !text.trimmingCharacters(in: .whitespaces).isEmpty }

    /// A folder was picked: the name fills from the folder unless the person already typed one.
    public mutating func chooseFolder(_ path: String) {
        folderPath = path
        if !nameEdited { name = (path as NSString).lastPathComponent }
    }

    public var buttonTitle: String { kind == .invite ? "Join pond" : "Create pond" }

    public var canCreate: Bool {
        switch kind {
        case .folder: folderPath?.isEmpty == false
        case .clone: !cloneURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .invite: PondInviteText.cleaned(inviteCode) != nil
        }
    }
}

// MARK: New branch

public enum NewBranchStart: Equatable, Sendable {
    case defaultBranch
    case branch(String)
    case openBranch(String)
    case pullRequest(String)
    case issue(String)

    public var menuTitle: String {
        switch self {
        case .defaultBranch: "The default branch"
        case .branch: "Another branch"
        case .openBranch: "An existing branch"
        case .pullRequest: "A pull request"
        case .issue: "An issue"
        }
    }

    public var placeholder: String {
        switch self {
        case .defaultBranch: ""
        case .branch, .openBranch: "Branch name"
        case .pullRequest: "#123 or the PR's URL"
        case .issue: "#45 or the issue's URL"
        }
    }

    public var input: String {
        switch self {
        case .defaultBranch: ""
        case .branch(let s), .openBranch(let s), .pullRequest(let s), .issue(let s): s
        }
    }

    public func with(input: String) -> NewBranchStart {
        switch self {
        case .defaultBranch: .defaultBranch
        case .branch: .branch(input)
        case .openBranch: .openBranch(input)
        case .pullRequest: .pullRequest(input)
        case .issue: .issue(input)
        }
    }

    /// The host source; nil for the default branch (no source) and for input that does not parse.
    public var source: NativeWorkspaceSource? {
        switch self {
        case .defaultBranch: nil
        case .branch(let s): NativeWorkspaceSource.parse(s, as: "base")
        case .openBranch(let s): NativeWorkspaceSource.parse(s, as: "branch")
        case .pullRequest(let s): NativeWorkspaceSource.parse(s, as: "pr")
        case .issue(let s): NativeWorkspaceSource.parse(s, as: "issue")
        }
    }
}

public struct NewBranchForm: Equatable, Sendable {
    /// The stream's name as the person sees it ("Detached HEAD Duck"): filled from the host's suggestion, typing overrides.
    public var name = ""
    public var start: NewBranchStart = .defaultBranch
    public let defaultBranch: String
    public let preset: NewBranchPreset
    /// The host answered `suggest-stream`, so it reads a typed `name` as the title; an older one only takes a branch.
    public private(set) var hostNamesStreams = false
    /// The person typed in the field: a suggestion never replaces it.
    public private(set) var nameEdited = false

    public init(defaultBranch: String, preset: NewBranchPreset = .newFromDefault) {
        self.defaultBranch = defaultBranch.isEmpty ? "main" : defaultBranch
        self.preset = preset
        start = preset.start
    }

    /// The person typed (or cleared) the name.
    public mutating func setName(_ text: String) {
        name = text
        nameEdited = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The host suggested a name: it fills the field unless the person already typed one; `force` (the dice) replaces it.
    public mutating func applySuggestion(_ suggestion: NativeStreamSuggestion, force: Bool = false) {
        hostNamesStreams = true
        if force || !nameEdited {
            name = suggestion.title
            nameEdited = false
        }
    }

    /// The name field shows wherever the branch is new (from the default, a base or an issue); an opened branch and
    /// a pull request keep their own branch's name, so there it is hidden.
    public var showsName: Bool {
        switch start {
        case .defaultBranch, .branch, .issue: true
        case .openBranch, .pullRequest: false
        }
    }

    private var typedName: String? {
        guard showsName else { return nil }
        let t = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    /// The stream name sent as `name` (title, slugged by the host). Empty means the host picks one.
    public var nameToSend: String? { hostNamesStreams ? typedName : nil }

    /// A host too old to suggest names reads the field as the exact git branch, as before.
    public var branchToSend: String? { hostNamesStreams ? nil : typedName }

    /// "Start from" shows the default branch, or what was chosen instead.
    public var startLabel: String {
        switch start {
        case .defaultBranch: defaultBranch
        case .branch(let s): s.trimmingCharacters(in: .whitespaces).isEmpty ? "another branch" : s
        case .openBranch(let s): s.trimmingCharacters(in: .whitespaces).isEmpty ? "an existing branch" : s
        case .pullRequest(let s): s.trimmingCharacters(in: .whitespaces).isEmpty ? "a pull request" : "PR \(s)"
        case .issue(let s): s.trimmingCharacters(in: .whitespaces).isEmpty ? "an issue" : "issue \(s)"
        }
    }

    public var canCreate: Bool {
        if showsName, !hostNamesStreams, branchToSend == nil { return false }
        if case .defaultBranch = start { return true }
        return start.source != nil
    }
}

// MARK: Pickers

public enum PickerKind: Equatable, Sendable { case branches, pulls, issues }

extension NewBranchStart {
    /// Which list the page offers for this source; the default branch needs none.
    public var picker: PickerKind? {
        switch self {
        case .defaultBranch: nil
        case .branch, .openBranch: .branches
        case .pullRequest: .pulls
        case .issue: .issues
        }
    }

    /// What picking a row puts in the input: a branch's name, a pull request's or issue's "#number".
    public static func input(branch: NativeBranchChoice) -> String { branch.name }
    public static func input(item: NativePickItem) -> String { "#\(item.number)" }
}

public struct BranchRow: Equatable, Sendable, Identifiable {
    public var branch: NativeBranchChoice
    public var id: String { branch.name }
    /// An opened branch cannot be opened twice; as a base for a new branch it is fine.
    public var disabled: Bool
    public var note: String? { disabled ? "already open" : nil }
}

public enum PickerRows {
    /// Rows matching `query` (case-insensitive, any part of the name), in the host's order (newest first).
    public static func branches(_ list: [NativeBranchChoice], query: String, opening: Bool) -> [BranchRow] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return list.filter { q.isEmpty || $0.name.lowercased().contains(q) }
            .map { BranchRow(branch: $0, disabled: opening && $0.checkedOut) }
    }

    /// Matches a number ("12" or "#12"), part of the title or the author.
    public static func items(_ list: [NativePickItem], query: String) -> [NativePickItem] {
        var q = query.trimmingCharacters(in: .whitespaces).lowercased()
        if q.hasPrefix("#") { q.removeFirst() }
        guard !q.isEmpty else { return list }
        return list.filter { String($0.number).hasPrefix(q) || $0.title.lowercased().contains(q) || $0.author.lowercased().contains(q) }
    }

    /// "#number title · author · age".
    public static func line(_ item: NativePickItem, now: Date = Date()) -> String {
        var parts = ["#\(item.number) \(item.title)"]
        if !item.author.isEmpty { parts.append(item.author) }
        if let d = item.updatedAt { parts.append(age(d, now: now)) }
        return parts.joined(separator: " \u{00B7} ")
    }

    public static func age(_ date: Date, now: Date = Date()) -> String {
        let s = max(0, Int(now.timeIntervalSince(date)))
        switch s {
        case ..<60: return "now"
        case ..<3600: return "\(s / 60)m"
        case ..<86400: return "\(s / 3600)h"
        case ..<(86400 * 60): return "\(s / 86400)d"
        default: return "\(s / (86400 * 30))mo"
        }
    }

    /// The one quiet line when GitHub is out of reach; nil when the list is usable.
    public static func unavailableLine(_ list: NativePickList) -> String? {
        guard !list.available else { return nil }
        let r = list.reason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return r.isEmpty ? "GitHub isn\u{2019}t available for this pond." : r
    }
}

// MARK: New thread

public enum NewThreadRules {
    /// Start is on with a place, a model and words (an image alone is not a message), under the length cap, and
    /// when nothing is already starting.
    public static func canStart(text: String, hasPlace: Bool, hasModel: Bool, starting: Bool, connected: Bool = true) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return hasPlace && hasModel && connected && !starting && !t.isEmpty && t.count <= NewChatForm.maxLength
    }

    public static let startLabel = "Start thread"

    /// Only a Claude thread can hand work to other models; Codex never shows the option.
    public static func offersSplit(agent: NewChatAgent) -> Bool { agent == .claude }

    /// The `split` sent with the first message: nil unless it is on, the agent is Claude, and a worker is named.
    public static func split(agent: NewChatAgent, on: Bool, code: String?, run: String?) -> WorkSplit? {
        guard on, offersSplit(agent: agent) else { return nil }
        let w = WorkSplit(code: code, run: run)
        return w.isEmpty ? nil : w
    }
}

public enum QuickPlace {
    /// The place the quick panel and the menu-bar popup open on: the branch with the newest thread (`recentCwds`,
    /// newest first, from the sidebar), else the newest branch the host lists last. Archived branches never.
    public static func defaultWorkspace(recentCwds: [String], workspaces: [NativeWorkspace]) -> NativeWorkspace? {
        let live = workspaces.filter { $0.state != "archived" }
        for cwd in recentCwds {
            if let w = live.first(where: { $0.path == cwd }) { return w }
        }
        return live.last
    }
}

extension NativeNewChatForm {
    /// The presets this agent's models offer (none when fewer than two differ).
    public var presets: [ChatPreset] {
        let all = [ChatPreset.best, .balanced, .save].filter { ChatPresets.setup(for: $0, agent: agent, models: models) != nil }
        return all.count > 1 ? all : []
    }

    public var activePreset: ChatPreset {
        [ChatPreset.best, .balanced, .save].first {
            let s = ChatPresets.setup(for: $0, agent: agent, models: models)
            return s?.modelId == modelId && s?.level == effort
        } ?? .custom
    }

    public mutating func apply(preset: ChatPreset) {
        guard let s = ChatPresets.setup(for: preset, agent: agent, models: models), let id = s.modelId else { return }
        pick(modelId: id)
        if let l = s.level { pick(effort: l) }
    }

    public var planFirst: Bool { mode == .plan }
    public mutating func set(planFirst on: Bool) { mode = on ? .plan : .ask }
}
