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
    /// The pond the daemon placed the chat in (the directory id); nil = Other, or an older daemon.
    public var pondId: String?
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
    /// Tokens used and the window's size where the source says (a Squeak chat); nil otherwise.
    public var contextTokens: Int?
    public var contextLimit: Int?
    /// The workspace's own name where the source has one (a Squeak chat's bird); else the sidebar uses the folder's.
    public var workspaceName: String?
    /// The workspace's readable title (a Squeak stream's "Wood Duck"); nil where the source has none. `workspaceName` stays the slug.
    public var workspaceTitle: String?
    /// A working Conductor chat whose own turn ended and only background tasks run (the quiet loader, §8.1).
    /// Nil when the source cannot tell; the daemon does not send it yet.
    public var backgroundWaiting: Bool?
    /// How many background tasks (subagents, shells) the chat has running; nil when the source cannot tell.
    public var backgroundCount: Int?
    /// Background helpers (ducklings) the host or daemon reports; nil from an older one. Never makes the chat working.
    public var ducklings: DucklingSet?
    /// Repeating the same failing step (the daemon's `looping`, only while working); nil otherwise or from an older daemon.
    public var looping: DaemonLoop?
    /// When the person archived this Squeak chat; nil for a chat in the list. Archived chats leave every list.
    public var archivedAt: Date?
    /// The host says this Squeak chat is very large: replies are slow and may fail (the notice above the composer).
    public var largeChat: Bool? = nil
    /// With `largeChat`: automatic compaction is on, so the chat compacts itself soon.
    public var largeCompacting: Bool? = nil
    /// The context size at which the chat compacts itself: nil = unknown (older host), .some(nil) = automatic compaction is off.
    public var autoCompactAt: Int?? = nil
    /// This Squeak chat's last turn failed in a way "Try again" can resend.
    public var retryable: Bool? = nil
    /// The host says this chat's folder (its Stream's working copy) is gone from disk, so no agent can start there; nil otherwise.
    public var streamMissing: StreamMissing? = nil
    /// The host says only a duckling works in this working chat (`ClaudeActivity`); nil from an older host.
    public var hostDucklingsOnly: Bool? = nil
    /// The host's own word that this chat's helpers keep it working although its turn ended (`helpersKeepWorking`: a running
    /// subagent, an unreported one, a shell started in the last minute; an old shell, a dev server left up, does not).
    /// nil: the host says nothing (an older host, a daemon row), so a running helper counts as it used to.
    public var helpersWorking: Bool? = nil
    /// Set by `ClaudeActivity.apply`: the chat reads as ready (its state) but Claude's turn is still open, waiting on a
    /// foreground duckling, so a message is queued or steered, never started as a new turn.
    public var turnOpen: Bool? = nil
    /// A Squeak chat: when the host last ended a turn. Lets the Mac end its optimistic "working" for a chat it is not streaming.
    public var lastTurnEndedAt: Date? = nil
    /// The duck this chat belongs to (a daemon with `ducksOwnBranch`); nil from an older one.
    public var duckId: String? = nil
    /// A failed chat: when the person opened or dismissed the failure (the host's `errorSeenAt`); nil until then.
    public var errorSeenAt: Date? = nil
    /// A failed chat: the failure's own words (the host's `needsYou.text`); nil when it sent none.
    public var failureText: String? = nil

    public var id: SessionKey { key }

    /// Background work still running for this chat: the same figure the composer bar counts (ducklings, or the host's
    /// background shells and tasks, whichever is larger). One signal for every "is it doing something" look.
    public var backgroundRunning: Int { max(ducklings?.running ?? 0, backgroundCount ?? 0) }

    /// Working now, or idle with background work running: the chat keeps its working look (sidebar, tabs, stream rows).
    public var isActive: Bool { alive != false && (state == .working || helpersKeepWorking) }

    /// Background work keeps this chat working: the host's rule (`helpersWorking`), never the bare count of running
    /// helpers, which includes a shell left up for days. An errored chat stays errored (the daemon's rule: only a
    /// finished or idle chat is held), so a stale helper never draws the working glyph over a failure.
    public var helpersKeepWorking: Bool {
        guard alive != false, state != .error else { return false }
        if let helpersWorking { return helpersWorking || (backgroundCount ?? 0) > 0 }
        return backgroundRunning > 0
    }

    /// Working and repeating a failing step: the daemon's `looping` counts as the person's to act on, so it sits under
    /// Needs you (one rule for every list, count and mark). Clears with the flag, or when the chat stops working.
    public var isLoopingNow: Bool { state == .working && alive != false && looping != nil }

    /// "Repeating a failing step: <label> ×N", the Needs you row's words; nil unless `isLoopingNow`.
    public var loopingSentence: String? {
        guard isLoopingNow, let l = looping else { return nil }
        return "Repeating a failing step: \(l.label) ×\(l.count)"
    }

    public init(
        key: SessionKey, title: String = "", distinctTitle: String? = nil, repoName: String? = nil,
        branch: String? = nil, cwd: String? = nil, agent: String? = nil, state: SessionState = .unknown,
        lastActivityAt: Date? = nil, alive: Bool? = nil, replyTarget: String? = nil,
        conductorWorkspaceId: String? = nil, conductorSessionId: String? = nil,
        capabilities: Capabilities = Capabilities(), origin: SessionOwnership = .hostOwned,
        awaitingApproval: Bool? = nil, pendingQuestion: String? = nil, contextPercent: Double? = nil,
        workspaceName: String? = nil, backgroundWaiting: Bool? = nil, workspaceTitle: String? = nil,
        backgroundCount: Int? = nil, contextTokens: Int? = nil, contextLimit: Int? = nil, ducklings: DucklingSet? = nil,
        looping: DaemonLoop? = nil, archivedAt: Date? = nil, pondId: String? = nil
    ) {
        self.pondId = pondId
        self.archivedAt = archivedAt
        self.looping = looping
        self.ducklings = ducklings
        self.contextTokens = contextTokens
        self.contextLimit = contextLimit
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
        self.backgroundCount = backgroundCount
    }

    /// What the UI and notifications call this session.
    public var label: String {
        if let d = distinctTitle, !d.isEmpty { return d }
        if !title.isEmpty { return title }
        if let r = repoName, !r.isEmpty { return r }
        return "Untitled"
    }
}

/// A chat whose Stream folder was removed from disk. Computed by the host (`streamMissing` on the chat); the Mac only words it.
public struct StreamMissing: Sendable, Hashable, Codable {
    /// The folder that is gone.
    public var path: String
    /// The Stream's branch when the host knows it (it may still exist, so a new Stream can reopen it).
    public var branch: String?
    /// The folder's own name.
    public var folder: String

    public init(path: String, branch: String? = nil, folder: String) {
        self.path = path; self.branch = branch; self.folder = folder
    }
}
