import Foundation

public enum SessionState: String, Codable, Sendable, Hashable {
    case working, blocked, finished, idle, error, unknown

    /// Maps the daemon's FleetState spellings.
    public init(daemon raw: String?) {
        switch raw {
        case "working": self = .working
        case "awaiting_approval", "awaiting_input", "blocked": self = .blocked
        case "finished": self = .finished
        case "idle": self = .idle
        case "error": self = .error
        default: self = .unknown
        }
    }
}

public enum SessionOwnership: String, Codable, Sendable, Hashable {
    /// The host app owns the chat; we only talk into it.
    case hostOwned
    /// Squeak created and manages the session.
    case squeakManaged
}

public struct HostSession: Hashable, Codable, Sendable, Identifiable {
    public var key: SessionKey
    public var title: String
    public var distinctTitle: String?
    public var repoName: String?
    public var branch: String?
    public var cwd: String?
    public var agent: String?
    public var state: SessionState
    public var lastActivityAt: Date?
    public var alive: Bool?
    public var replyTarget: String?
    public var conductorWorkspaceId: String?
    public var conductorSessionId: String?
    public var capabilities: Capabilities
    public var origin: SessionOwnership
    /// The daemon said `awaiting_approval` (not just input). Nil when the source cannot tell.
    public var awaitingApproval: Bool?
    /// What a blocked agent is asking (first question plus its options, or
    /// "has a plan for you to review"). Nil unless it is waiting on a question.
    public var pendingQuestion: String?
    /// How full the chat's context window is, 0-100 (Conductor's `context_used_percent`); nil when unknown.
    public var contextPercent: Double?
    /// The workspace's own name where the source has one (a Squeak chat's bird); else the sidebar uses the folder's.
    public var workspaceName: String?
    /// The workspace's readable title (a Squeak stream's "Wood Duck"); nil where the source has none. `workspaceName` stays the slug.
    public var workspaceTitle: String?
    /// A working Conductor chat whose own turn ended and only background tasks run (the quiet loader, §8.1).
    /// Nil when the source cannot tell; the daemon does not send it yet.
    public var backgroundWaiting: Bool?

    public var id: SessionKey { key }

    public init(
        key: SessionKey, title: String = "", distinctTitle: String? = nil, repoName: String? = nil,
        branch: String? = nil, cwd: String? = nil, agent: String? = nil, state: SessionState = .unknown,
        lastActivityAt: Date? = nil, alive: Bool? = nil, replyTarget: String? = nil,
        conductorWorkspaceId: String? = nil, conductorSessionId: String? = nil,
        capabilities: Capabilities = Capabilities(), origin: SessionOwnership = .hostOwned,
        awaitingApproval: Bool? = nil, pendingQuestion: String? = nil, contextPercent: Double? = nil,
        workspaceName: String? = nil, backgroundWaiting: Bool? = nil, workspaceTitle: String? = nil
    ) {
        self.key = key
        self.title = title
        self.distinctTitle = distinctTitle
        self.repoName = repoName
        self.branch = branch
        self.cwd = cwd
        self.agent = agent
        self.state = state
        self.lastActivityAt = lastActivityAt
        self.alive = alive
        self.replyTarget = replyTarget
        self.conductorWorkspaceId = conductorWorkspaceId
        self.conductorSessionId = conductorSessionId
        self.capabilities = capabilities
        self.origin = origin
        self.awaitingApproval = awaitingApproval
        self.pendingQuestion = pendingQuestion
        self.contextPercent = contextPercent
        self.workspaceName = workspaceName
        self.workspaceTitle = workspaceTitle
        self.backgroundWaiting = backgroundWaiting
    }

    /// What the UI and notifications call this session.
    public var label: String {
        if let d = distinctTitle, !d.isEmpty { return d }
        if !title.isEmpty { return title }
        if let r = repoName, !r.isEmpty { return r }
        return "Untitled"
    }
}
