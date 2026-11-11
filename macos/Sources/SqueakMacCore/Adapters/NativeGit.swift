import Foundation

// The host's git, workspace-lifecycle and project-settings routes (src/native/server.ts, git-actions.ts,
// project-settings.ts), for Squeak-run chats only. The host decides everything; these types only carry its
// answers, and `GitPresentation` (below) is the one place the Mac turns them into what the header and the PR tab say.

public struct NativePullRequest: Sendable, Equatable, Decodable {
    public enum State: String, Sendable, Equatable { case open, merged, closed }
    public enum Checks: String, Sendable, Equatable { case passing, failing, running, none }

    public var number: Int
    public var url: String
    public var state: State
    public var draft: Bool
    /// true: can merge; false: conflicts; nil: GitHub has not worked it out yet.
    public var mergeable: Bool?
    public var checks: Checks

    enum CodingKeys: String, CodingKey { case number, url, state, draft, mergeable, checks }

    public init(number: Int, url: String = "", state: State = .open, draft: Bool = false, mergeable: Bool? = nil, checks: Checks = .none) {
        self.number = number; self.url = url; self.state = state; self.draft = draft; self.mergeable = mergeable; self.checks = checks
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        number = try c.decode(Int.self, forKey: .number)
        url = c.lenient(String.self, .url) ?? ""
        state = c.lenient(String.self, .state).flatMap(State.init(rawValue:)) ?? .open
        draft = c.lenient(Bool.self, .draft) ?? false
        mergeable = c.lenient(Bool.self, .mergeable)
        checks = c.lenient(String.self, .checks).flatMap(Checks.init(rawValue:)) ?? .none
    }
}

/// `GET /native/sessions/<id>/git`.
public struct NativeGitStatus: Sendable, Equatable, Decodable {
    public var branch: String?
    public var base: String
    public var ahead: Int?
    public var behind: Int?
    public var dirty: Int
    public var upstream: String?
    public var pr: NativePullRequest?
    /// Why `pr` is missing: `gh-missing`, `none` (the branch has no PR) or `unavailable`.
    public var prReason: String?
    public var prMessage: String?

    enum CodingKeys: String, CodingKey { case branch, base, ahead, behind, dirty, upstream, pr, prReason, prMessage }

    public init(
        branch: String? = nil, base: String = "main", ahead: Int? = nil, behind: Int? = nil, dirty: Int = 0, upstream: String? = nil,
        pr: NativePullRequest? = nil, prReason: String? = nil, prMessage: String? = nil
    ) {
        self.branch = branch; self.base = base; self.ahead = ahead; self.behind = behind; self.dirty = dirty
        self.upstream = upstream; self.pr = pr; self.prReason = pr == nil ? (prReason ?? "none") : nil; self.prMessage = prMessage
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        branch = c.lenient(String.self, .branch)
        base = c.lenient(String.self, .base) ?? "main"
        ahead = c.lenient(Int.self, .ahead)
        behind = c.lenient(Int.self, .behind)
        dirty = c.lenient(Int.self, .dirty) ?? 0
        upstream = c.lenient(String.self, .upstream)
        pr = c.lenient(NativePullRequest.self, .pr)
        prReason = c.lenient(String.self, .prReason)
        prMessage = c.lenient(String.self, .prMessage)
    }
}

public struct NativeRunStatus: Sendable, Equatable, Decodable {
    public var running: Bool
    public var port: Int?
    public var logTail: String

    enum CodingKeys: String, CodingKey { case running, port, logTail }

    public init(running: Bool, port: Int? = nil, logTail: String = "") { self.running = running; self.port = port; self.logTail = logTail }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        running = c.lenient(Bool.self, .running) ?? false
        port = c.lenient(Int.self, .port)
        logTail = c.lenient(String.self, .logTail) ?? ""
    }
}

public struct NativeWorkspaceLog: Sendable, Equatable, Decodable {
    public var state: String
    public var log: String
}

/// What a project stores, what is used, and where each value came from (`GET /native/projects/<id>/settings`).
public struct NativeProjectSettings: Sendable, Equatable, Decodable {
    public static let actions = [
        "create-pr", "commit-push", "fix-errors", "resolve-conflicts", "review", "pull-latest", "changelog",
    ]
    public static let methods = ["squash", "merge", "rebase"]

    public struct Stored: Sendable, Equatable, Decodable {
        public var setupScript: String?
        public var runScript: String?
        public var archiveScript: String?
        public var branchPrefix: String?
        public var mergeMethod: String?
        /// A model for Review: when set, Review starts its own chat with it.
        public var reviewModel: String?
        public var reviewEffort: String?
        public var prompts: [String: String]

        public init(
            setupScript: String? = nil, runScript: String? = nil, archiveScript: String? = nil, branchPrefix: String? = nil,
            mergeMethod: String? = nil, reviewModel: String? = nil, reviewEffort: String? = nil, prompts: [String: String] = [:]
        ) {
            self.setupScript = setupScript; self.runScript = runScript; self.archiveScript = archiveScript
            self.branchPrefix = branchPrefix; self.mergeMethod = mergeMethod; self.prompts = prompts
            self.reviewModel = reviewModel; self.reviewEffort = reviewEffort
        }

        enum CodingKeys: String, CodingKey { case setupScript, runScript, archiveScript, branchPrefix, mergeMethod, reviewModel, reviewEffort, prompts }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            setupScript = c.lenient(String.self, .setupScript)
            runScript = c.lenient(String.self, .runScript)
            archiveScript = c.lenient(String.self, .archiveScript)
            branchPrefix = c.lenient(String.self, .branchPrefix)
            mergeMethod = c.lenient(String.self, .mergeMethod)
            reviewModel = c.lenient(String.self, .reviewModel)
            reviewEffort = c.lenient(String.self, .reviewEffort)
            prompts = c.lenient([String: String].self, .prompts) ?? [:]
        }
    }

    public struct Effective: Sendable, Equatable, Decodable {
        public var setupScript: String?
        public var runScript: String?
        public var archiveScript: String?
        public var branchPrefix: String
        public var mergeMethod: String
        public var reviewModel: String?
        public var reviewEffort: String?
        public var prompts: [String: String]

        public init(
            setupScript: String? = nil, runScript: String? = nil, archiveScript: String? = nil, branchPrefix: String = "",
            mergeMethod: String = "squash", reviewModel: String? = nil, reviewEffort: String? = nil, prompts: [String: String] = [:]
        ) {
            self.setupScript = setupScript; self.runScript = runScript; self.archiveScript = archiveScript
            self.branchPrefix = branchPrefix; self.mergeMethod = mergeMethod; self.prompts = prompts
            self.reviewModel = reviewModel; self.reviewEffort = reviewEffort
        }

        enum CodingKeys: String, CodingKey { case setupScript, runScript, archiveScript, branchPrefix, mergeMethod, reviewModel, reviewEffort, prompts }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            setupScript = c.lenient(String.self, .setupScript)
            runScript = c.lenient(String.self, .runScript)
            archiveScript = c.lenient(String.self, .archiveScript)
            branchPrefix = c.lenient(String.self, .branchPrefix) ?? ""
            mergeMethod = c.lenient(String.self, .mergeMethod) ?? "squash"
            reviewModel = c.lenient(String.self, .reviewModel)
            reviewEffort = c.lenient(String.self, .reviewEffort)
            prompts = c.lenient([String: String].self, .prompts) ?? [:]
        }
    }

    /// `project`, `conductor.json` or `default`, per field.
    public struct Sources: Sendable, Equatable, Decodable {
        public var setupScript: String
        public var runScript: String
        public var archiveScript: String
        public var branchPrefix: String
        public var mergeMethod: String
        public var prompts: [String: String]

        public init(
            setupScript: String = "default", runScript: String = "default", archiveScript: String = "default",
            branchPrefix: String = "default", mergeMethod: String = "default", prompts: [String: String] = [:]
        ) {
            self.setupScript = setupScript; self.runScript = runScript; self.archiveScript = archiveScript
            self.branchPrefix = branchPrefix; self.mergeMethod = mergeMethod; self.prompts = prompts
        }

        enum CodingKeys: String, CodingKey { case setupScript, runScript, archiveScript, branchPrefix, mergeMethod, prompts }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            setupScript = c.lenient(String.self, .setupScript) ?? "default"
            runScript = c.lenient(String.self, .runScript) ?? "default"
            archiveScript = c.lenient(String.self, .archiveScript) ?? "default"
            branchPrefix = c.lenient(String.self, .branchPrefix) ?? "default"
            mergeMethod = c.lenient(String.self, .mergeMethod) ?? "default"
            prompts = c.lenient([String: String].self, .prompts) ?? [:]
        }
    }

    public var settings: Stored
    public var effective: Effective
    public var sources: Sources
    public var defaultPrompts: [String: String]

    public init(settings: Stored = .init(), effective: Effective = .init(), sources: Sources = .init(), defaultPrompts: [String: String] = [:]) {
        self.settings = settings; self.effective = effective; self.sources = sources; self.defaultPrompts = defaultPrompts
    }

    enum CodingKeys: String, CodingKey { case settings, effective, sources, defaultPrompts }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = c.lenient(Stored.self, .settings) ?? .init()
        effective = c.lenient(Effective.self, .effective) ?? .init()
        sources = c.lenient(Sources.self, .sources) ?? .init()
        defaultPrompts = c.lenient([String: String].self, .defaultPrompts) ?? [:]
    }
}

// MARK: Client

extension NativeHostClient {
    private struct Archived: Decodable { var workspace: NativeWorkspace }

    public func gitStatus(sessionId: String) async throws -> NativeGitStatus {
        try JSONDecoder.native(NativeGitStatus.self, try await call("GET", "/native/sessions/\(Self.id(sessionId))/git", timeout: 15))
    }

    /// Sends the action's prompt to the chat as an ordinary message (the host fills in the project's wording).
    /// `queued` when the chat was working. Never retried: a timeout is `uncertain`, like any send.
    /// `sessionId` is set when the action started a new chat (Review on a project with a review model).
    public func gitAction(sessionId: String, action: GitActionKind) async throws -> (queued: Bool, prompt: String, sessionId: String?) {
        precondition(action != .merge, "merge has its own call")
        let r = try await call(
            "POST", "/native/sessions/\(Self.id(sessionId))/actions/\(action.rawValue)", body: .object([:]), timeout: 20, maybeSent: true)
        let j = try? JSONDecoder().decode(NativeJSON.self, from: r)
        return (j?["queued"]?.bool ?? false, j?["prompt"]?.string ?? "", j?["sessionId"]?.string)
    }

    /// `gh pr merge` with the project's method; the host refuses (409) a draft, a conflict, failing or unfinished checks.
    public func merge(sessionId: String) async throws -> String {
        let r = try await call(
            "POST", "/native/sessions/\(Self.id(sessionId))/actions/merge", body: .object(["confirm": .bool(true)]), timeout: 90, maybeSent: true)
        return (try? JSONDecoder().decode(NativeJSON.self, from: r))?["method"]?.string ?? "squash"
    }

    public func workspaceLog(workspaceId: String) async throws -> NativeWorkspaceLog {
        try JSONDecoder.native(NativeWorkspaceLog.self, try await call("GET", "/native/workspaces/\(Self.id(workspaceId))/log"))
    }

    public func runStatus(workspaceId: String) async throws -> NativeRunStatus {
        try JSONDecoder.native(NativeRunStatus.self, try await call("GET", "/native/workspaces/\(Self.id(workspaceId))/run"))
    }

    public func setRun(workspaceId: String, start: Bool) async throws -> NativeRunStatus {
        let body: NativeJSON = .object(["action": .string(start ? "start" : "stop")])
        return try JSONDecoder.native(
            NativeRunStatus.self, try await call("POST", "/native/workspaces/\(Self.id(workspaceId))/run", body: body, timeout: 30))
    }

    /// Refused (409) while a chat works, setup runs, or (without `force`) the tree is dirty; the host says which.
    public func archive(workspaceId: String, force: Bool = false) async throws -> NativeWorkspace {
        let body: NativeJSON = .object(force ? ["force": .bool(true)] : [:])
        return try JSONDecoder.native(
            Archived.self, try await call("POST", "/native/workspaces/\(Self.id(workspaceId))/archive", body: body, timeout: 60)).workspace
    }

    public func projectSettings(projectId: String) async throws -> NativeProjectSettings {
        try JSONDecoder.native(NativeProjectSettings.self, try await call("GET", "/native/projects/\(Self.id(projectId))/settings"))
    }

    public func patchProjectSettings(projectId: String, body: [String: NativeJSON]) async throws -> NativeProjectSettings {
        try JSONDecoder.native(
            NativeProjectSettings.self,
            try await call("PATCH", "/native/projects/\(Self.id(projectId))/settings", body: .object(body), timeout: 15))
    }

    /// `DELETE /native/projects/<id>`: Remove from Squeak. The host refuses (409, a plain sentence) while a chat works
    /// or waits; its folder and files are never touched, and its chats keep their history.
    public func removeProject(projectId: String) async throws {
        _ = try await call("DELETE", "/native/projects/\(Self.id(projectId))", timeout: 15)
    }
}

extension JSONDecoder {
    static func native<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try JSONDecoder().decode(type, from: data) } catch { throw NativeHostError.badResponse }
    }
}

// MARK: Pure logic

public enum GitActionKind: String, Sendable, CaseIterable, Equatable {
    case createPR = "create-pr", commitPush = "commit-push", fixErrors = "fix-errors"
    case resolveConflicts = "resolve-conflicts", review, merge
    case pullLatest = "pull-latest", changelog

    /// Conductor's own wording.
    public var title: String {
        switch self {
        case .createPR: "Create PR"
        case .commitPush: "Commit & push"
        case .fixErrors: "Fix errors"
        case .resolveConflicts: "Resolve conflicts"
        case .review: "Review"
        case .merge: "Merge"
        case .pullLatest: "Pull latest"
        case .changelog: "Write changelog"
        }
    }

    /// The letter of its ⌘⇧ shortcut (Conductor's P, Y, M, X, R, and L for Pull latest); conflicts have none.
    public var shortcutKey: Character? {
        switch self {
        case .createPR: "p"
        case .commitPush: "y"
        case .merge: "m"
        case .fixErrors: "x"
        case .review: "r"
        case .pullLatest: "l"
        case .resolveConflicts, .changelog: nil
        }
    }

    /// The menu's order.
    public static let menuOrder: [GitActionKind] = [
        .commitPush, .createPR, .pullLatest, .fixErrors, .resolveConflicts, .review, .changelog, .merge,
    ]
}

/// The header's one button, which follows the state like Conductor's.
public enum GitPrimary: Equatable, Sendable {
    case action(GitActionKind)
    /// A quiet word, not a button.
    case merged
    case closed
}

public enum GitPresentation {
    /// The PR tab and the header refresh like Changes: every 10 s while on screen, at once when activity changed.
    public static let refreshInterval: TimeInterval = ChangesPresentation.refreshInterval

    public static func shouldRefresh(visible: Bool, activityChanged: Bool, lastRead: Date?, now: Date) -> Bool {
        ChangesPresentation.shouldRefresh(visible: visible, activityChanged: activityChanged, lastRead: lastRead, now: now)
    }

    private static func hasWork(_ s: NativeGitStatus) -> Bool { s.dirty > 0 || (s.ahead ?? 0) > 0 }

    /// No PR: Create PR (once there is something to put in one). Open: conflicts first, then failing checks, then
    /// what is not committed, then Merge. A draft, unfinished checks or a merge GitHub has not worked out yet have
    /// no button (the checks say it). Merged and closed are quiet words.
    public static func primary(_ s: NativeGitStatus) -> GitPrimary? {
        guard let pr = s.pr else { return s.prReason == "none" && hasWork(s) ? .action(.createPR) : nil }
        switch pr.state {
        case .merged: return .merged
        case .closed: return .closed
        case .open:
            if pr.draft { return nil }
            if pr.mergeable == false { return .action(.resolveConflicts) }
            if pr.checks == .failing { return .action(.fixErrors) }
            if s.dirty > 0 { return .action(.commitPush) }
            if pr.mergeable == true, pr.checks != .running { return .action(.merge) }
            return nil
        }
    }

    public static func isEnabled(_ kind: GitActionKind, _ s: NativeGitStatus) -> Bool {
        let open = s.pr?.state == .open ? s.pr : nil
        switch kind {
        case .commitPush, .review, .changelog: return hasWork(s)
        case .pullLatest: return (s.behind ?? 0) > 0
        case .createPR: return (s.pr == nil || s.pr?.state == .closed) && s.prReason != "gh-missing" && hasWork(s)
        case .fixErrors: return open?.checks == .failing
        case .resolveConflicts: return open?.mergeable == false
        case .merge: return open.map { !$0.draft && $0.mergeable == true && $0.checks != .failing } ?? false
        }
    }

    /// "Open PR in browser" needs a PR to open.
    public static func prURL(_ s: NativeGitStatus) -> URL? {
        guard let u = s.pr?.url, u.hasPrefix("https://") else { return nil }
        return URL(string: u)
    }

    /// The PR's own word for its state, and nothing else: Draft, Open, Merged, Closed.
    public static func prWord(_ pr: NativePullRequest) -> String {
        switch pr.state {
        case .merged: "Merged"
        case .closed: "Closed"
        case .open: pr.draft ? "Draft" : "Open"
        }
    }

    public static func prLine(_ pr: NativePullRequest) -> String { "#\(pr.number) · \(prWord(pr))" }

    /// A mark for the checks (never a state word): passing is a check, failing a cross, running the loader; none draws nothing.
    public enum ChecksMark: Equatable, Sendable { case passing, failing, running }

    public static func checksMark(_ pr: NativePullRequest) -> ChecksMark? {
        switch pr.checks {
        case .passing: .passing
        case .failing: .failing
        case .running: .running
        case .none: nil
        }
    }

    /// The words behind the mark: tooltip and VoiceOver.
    public static func checksWords(_ pr: NativePullRequest) -> String {
        switch pr.checks {
        case .passing: "Checks passed"
        case .failing: "Checks failed"
        case .running: "Checks running"
        case .none: "No checks"
        }
    }

    /// The mergeable line of the PR tab, a sentence; nil once the PR is merged or closed.
    public static func mergeableLine(_ s: NativeGitStatus) -> String? {
        guard let pr = s.pr, pr.state == .open else { return nil }
        if pr.draft { return "A draft: mark it ready before it can merge." }
        switch pr.mergeable {
        case false?: return "Conflicts with \(s.base). Ask the chat to resolve them."
        case true?: return pr.checks == .failing ? "No conflicts, but the checks are failing." : "No conflicts with \(s.base)."
        case nil: return "GitHub is still checking whether it can merge."
        }
    }

    /// "↑2 ↓1" against the base; zeros and unknowns are left out; nil when there is nothing to say.
    public static func aheadBehind(_ s: NativeGitStatus) -> String? {
        var parts: [String] = []
        if let a = s.ahead, a > 0 { parts.append("↑\(a)") }
        if let b = s.behind, b > 0 { parts.append("↓\(b)") }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    public static func aheadBehindWords(_ s: NativeGitStatus) -> String {
        var parts: [String] = []
        if let a = s.ahead, a > 0 { parts.append("\(a) ahead of \(s.base)") }
        if let b = s.behind, b > 0 { parts.append("\(b) behind \(s.base)") }
        return parts.joined(separator: ", ")
    }

    public static func methodTitle(_ method: String) -> String {
        switch method {
        case "merge": "Create a merge commit"
        case "rebase": "Rebase and merge"
        default: "Squash and merge"
        }
    }

    /// The merge confirm sheet's sentence: names the PR, the method and where it lands.
    public static func mergeSentence(_ pr: NativePullRequest, base: String, method: String) -> String {
        "\(methodTitle(method)) pull request #\(pr.number) into \(base)."
    }

    /// A host-down or gh problem in one sentence for the quiet note under the header cluster.
    public static func note(_ s: NativeGitStatus) -> String? {
        guard s.pr == nil, s.prReason == "gh-missing" || s.prReason == "unavailable" else { return nil }
        return s.prMessage
    }
}

public enum WorkspaceLifecycle {
    public enum Mark: Equatable, Sendable { case settingUp, setupFailed }

    public static func mark(_ state: String) -> Mark? {
        switch state {
        case "setting_up": .settingUp
        case "setup_failed": .setupFailed
        default: nil
        }
    }

    public static func words(_ mark: Mark) -> String { mark == .settingUp ? "Setting up" : "Setup failed" }

    /// How often the sidebar asks the host about workspaces: briskly while one sets up, else lazily.
    public static func pollInterval(_ workspaces: [NativeWorkspace]) -> TimeInterval {
        workspaces.contains { $0.state == "setting_up" } ? 2 : 20
    }

    public static func localhostURL(port: Int?) -> URL? { port.flatMap { URL(string: "http://localhost:\($0)") } }

    public static func openTitle(port: Int?) -> String? { port.map { "Open localhost:\($0)" } }

    /// What the host's archive refusal means: only a dirty tree can be forced; a busy chat or a running setup cannot.
    public enum Refusal: Equatable, Sendable { case uncommitted, other(String) }

    public static func refusal(_ error: Error) -> Refusal {
        let reason = (error as? NativeHostError)?.reason ?? "Squeak couldn't archive the stream"
        if case NativeHostError.http(_, let m?) = error, m.localizedCaseInsensitiveContains("uncommitted") { return .uncommitted }
        return .other(reason)
    }
}

/// Edits to a project's settings sheet, turned into the host's PATCH body: only what changed; an empty field clears
/// (null), and a prompt left as the default clears too.
public struct ProjectSettingsDraft: Equatable, Sendable {
    public var setupScript: String
    public var runScript: String
    public var archiveScript: String
    public var branchPrefix: String
    /// "" = the default.
    public var mergeMethod: String
    /// "" = review in the chat itself.
    public var reviewModel: String
    public var reviewEffort: String
    public var prompts: [String: String]

    public init(_ s: NativeProjectSettings) {
        reviewModel = s.settings.reviewModel ?? ""
        reviewEffort = s.settings.reviewEffort ?? ""
        setupScript = s.settings.setupScript ?? ""
        runScript = s.settings.runScript ?? ""
        archiveScript = s.settings.archiveScript ?? ""
        branchPrefix = s.settings.branchPrefix ?? ""
        mergeMethod = s.settings.mergeMethod ?? ""
        var p: [String: String] = [:]
        for a in NativeProjectSettings.actions { p[a] = s.settings.prompts[a] ?? "" }
        prompts = p
    }

    public func patch(from original: NativeProjectSettings) -> [String: NativeJSON] {
        let base = ProjectSettingsDraft(original)
        func text(_ v: String) -> NativeJSON { v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .null : .string(v) }
        var body: [String: NativeJSON] = [:]
        if setupScript != base.setupScript { body["setupScript"] = text(setupScript) }
        if runScript != base.runScript { body["runScript"] = text(runScript) }
        if archiveScript != base.archiveScript { body["archiveScript"] = text(archiveScript) }
        if branchPrefix != base.branchPrefix { body["branchPrefix"] = text(branchPrefix.trimmingCharacters(in: .whitespaces)) }
        if mergeMethod != base.mergeMethod { body["mergeMethod"] = mergeMethod.isEmpty ? .null : .string(mergeMethod) }
        if reviewModel != base.reviewModel { body["reviewModel"] = reviewModel.isEmpty ? .null : .string(reviewModel) }
        if reviewEffort != base.reviewEffort, !reviewModel.isEmpty || reviewEffort.isEmpty {
            body["reviewEffort"] = reviewEffort.isEmpty ? .null : .string(reviewEffort)
        }
        var prompts: [String: NativeJSON] = [:]
        for a in NativeProjectSettings.actions where self.prompts[a] != base.prompts[a] {
            let v = self.prompts[a] ?? ""
            prompts[a] = v == original.defaultPrompts[a] ? .null : text(v)
        }
        if !prompts.isEmpty { body["prompts"] = .object(prompts) }
        return body
    }
}
