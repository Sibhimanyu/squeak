import Foundation

/// Where the Create page's new work starts (the "Start work" section's source picker).
public enum CreateStartKind: String, CaseIterable, Sendable, Equatable {
    /// A fresh worktree the host names, cut from the project's default branch.
    case newBranch
    case existingBranch
    case pullRequest
    case issue

    public var title: String {
        switch self {
        case .newBranch: "New branch"
        case .existingBranch: "Existing branch"
        case .pullRequest: "Pull request"
        case .issue: "Issue"
        }
    }

    public var needsInput: Bool { self != .newBranch }

    public var placeholder: String {
        switch self {
        case .newBranch: ""
        case .existingBranch: "Branch name"
        case .pullRequest: "#123 or the PR's URL"
        case .issue: "#45 or the issue's URL"
        }
    }

    /// One sentence under the picker.
    public var hint: String {
        switch self {
        case .newBranch: "A new worktree branched from the pond's default branch."
        case .existingBranch: "That branch itself is checked out in a new workspace."
        case .pullRequest: "The PR's branch is checked out, so what you push updates it."
        case .issue: "A branch named after the issue, and a first message that carries it."
        }
    }

    /// `NativeWorkspaceSource.parse`'s kind word; nil for a plain new workspace.
    var hostKind: String? {
        switch self {
        case .newBranch: nil
        case .existingBranch: "branch"
        case .pullRequest: "pr"
        case .issue: "issue"
        }
    }

    /// The host source for what was typed; nil for a new branch (no source) and for input that does not parse.
    public func source(from input: String) -> NativeWorkspaceSource? {
        hostKind.flatMap { NativeWorkspaceSource.parse(input, as: $0) }
    }
}

public struct CreateSections: Equatable, Sendable {
    /// With no pond, "New pond" leads the page and Start work waits.
    public var addProjectLeads: Bool
    public var startWorkEnabled: Bool
    public var startWorkNote: String?
    public var showsPonds: Bool
}

public enum CreateWork {
    public static let addProjectFirst = PondWords.makePondFirst

    public static func sections(projectCount: Int) -> CreateSections {
        let none = projectCount == 0
        return CreateSections(addProjectLeads: none, startWorkEnabled: !none, startWorkNote: none ? addProjectFirst : nil, showsPonds: true)
    }

    /// Projects with recent work first (`activityOrder`: project names newest first, from the sidebar's tree), then
    /// the rest in the host's order.
    public static func orderedProjects(_ projects: [NativeProject], activityOrder: [String]) -> [NativeProject] {
        let rank = Dictionary(activityOrder.enumerated().map { ($1.lowercased(), $0) }, uniquingKeysWith: { a, _ in a })
        let indexed = projects.enumerated().map { (offset: $0, project: $1) }
        return indexed.sorted { a, b in
            switch (rank[a.project.name.lowercased()], rank[b.project.name.lowercased()]) {
            case let (x?, y?): x != y ? x < y : a.offset < b.offset
            case (_?, nil): true
            case (nil, _?): false
            case (nil, nil): a.offset < b.offset
            }
        }.map(\.project)
    }

    /// Start is on when a project and a model are chosen, the source parses, and there is something to say (an
    /// issue brings its own first message, so it may go without words).
    public static func canStart(form: NativeNewChatForm, kind: CreateStartKind, input: String) -> Bool {
        guard form.project != nil, form.chosenModel != nil, form.trimmedText.count <= NewChatForm.maxLength else { return false }
        if kind.needsInput, kind.source(from: input) == nil { return false }
        return kind == .issue || !form.trimmedText.isEmpty
    }

    /// The chat to start in a workspace made from a source.
    public static func session(form: NativeNewChatForm, workspace: NativeWorkspace, issuePrompt: String?) -> NativeNewSession? {
        guard let project = form.project, let model = form.chosenModel?.id else { return nil }
        // An issue's own message leads; what was typed follows it.
        let text = [issuePrompt, form.trimmedText].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }.joined(separator: "\n\n")
        guard !text.isEmpty else { return nil }
        return NativeNewSession(
            agent: form.agent.rawValue, model: model, permissionMode: NativeModes.permissionMode(form.mode), effort: form.effort,
            cwd: workspace.path, projectId: project.id, text: text)
    }

    /// A plain new branch: the host makes the worktree and starts the chat in one call.
    public static func newBranchSession(form: NativeNewChatForm) -> NativeNewSession? {
        guard let project = form.project, let model = form.chosenModel?.id, !form.trimmedText.isEmpty else { return nil }
        return NativeNewSession(
            agent: form.agent.rawValue, model: model, permissionMode: NativeModes.permissionMode(form.mode), effort: form.effort,
            projectId: project.id, newWorkspace: true, text: form.trimmedText)
    }
}

/// Back and forward's places: a chat, or the Create page (`nil` in `NavHistory` is still the Dashboard).
public enum WorkbenchPlace: Equatable, Sendable {
    case chat(SessionKey)
    case create
}
