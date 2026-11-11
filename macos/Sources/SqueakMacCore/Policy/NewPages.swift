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
        case .newFromDefault, .newFrom: "New branch"
        case .openBranch: "Open branch"
        case .openPullRequest: "Open pull request"
        case .forIssue: "New branch for issue"
        }
    }

    public var buttonTitle: String {
        switch self {
        case .newFromDefault, .newFrom: "Create branch"
        case .openBranch, .openPullRequest: "Open branch"
        case .forIssue: "Create branch"
        }
    }

    /// The name comes from the source for an opened branch, a pull request and an issue.
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

/// Bird names, in the order the host hands them out (`BIRD_NAMES` in `src/native/workspaces.ts`).
public enum BranchNames {
    public static let birds = [
        "mallard", "teal", "wigeon", "pintail", "gadwall", "shoveler", "pochard", "goldeneye", "bufflehead", "scaup",
        "eider", "merganser", "smew", "garganey", "canvasback", "redhead", "scoter", "mandarin", "wood-duck", "ruddy",
    ]

    /// The first bird no worktree of the pond uses; with all taken, `<bird>-2`, `-3`, and so on, as the host does.
    public static func suggest(taken: [String]) -> String {
        let used = Set(taken.map { $0.lowercased() })
        if let b = birds.first(where: { !used.contains($0) }) { return b }
        var n = 2
        while true {
            if let b = birds.first(where: { !used.contains("\($0)-\(n)") }) { return "\(b)-\(n)" }
            n += 1
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
    public var name: String
    public var start: NewBranchStart = .defaultBranch
    public let defaultBranch: String
    public let preset: NewBranchPreset

    public init(defaultBranch: String, taken: [String], preset: NewBranchPreset = .newFromDefault) {
        self.defaultBranch = defaultBranch.isEmpty ? "main" : defaultBranch
        self.preset = preset
        start = preset.start
        name = BranchNames.suggest(taken: taken)
    }

    /// The name field shows only where the host takes the name from nowhere else.
    public var showsName: Bool {
        switch start {
        case .defaultBranch, .branch: true
        case .openBranch, .pullRequest, .issue: false
        }
    }

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
        if case .defaultBranch = start { return !name.trimmingCharacters(in: .whitespaces).isEmpty }
        // An opened branch, a pull request and an issue name themselves, so only the others need the name field.
        if showsName, name.trimmingCharacters(in: .whitespaces).isEmpty { return false }
        return start.source != nil
    }

    /// The host names a new branch itself (no name is sent): true while what is in the field is not that suggestion.
    public func nameIsIgnored(suggested: String) -> Bool {
        let t = name.trimmingCharacters(in: .whitespaces)
        if !showsName { return false }
        return !t.isEmpty && t != suggested
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
