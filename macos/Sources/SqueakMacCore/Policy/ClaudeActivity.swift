import Foundation

/// Whether Claude itself is doing something in a chat, or only its ducklings (subagents) are. The one definition every
/// surface reads: the chat's running row, the stop button, the composer, the sidebar, the dashboard and the tab marks.
///
///  - `claude`: any running thought, tool call, wait or reply being written, or a turn pressed and not yet running.
///  - `ducklingsOnly`: every running step of the current turn is a duckling (an Agent/Task call whose duckling is running),
///    so Claude is blocked on it (`turnOpen`, a foreground duckling), or the turn has ended and ducklings or helpers remain.
///  - `none`: nothing is running.
public enum ClaudeActivity: Equatable, Sendable {
    case claude
    case ducklingsOnly(turnOpen: Bool)
    case none

    public var claudeIsActive: Bool { self == .claude }
    public var onlyDucklings: Bool { if case .ducklingsOnly = self { true } else { false } }
    /// Claude's turn is still open although only a duckling works: a foreground duckling it waits on.
    public var turnOpen: Bool { self == .ducklingsOnly(turnOpen: true) }

    /// The step kinds that are Claude doing something. A steer waiting to be read, a note, an error and the progress
    /// tracker are not.
    static func isClaudeWork(_ kind: TimelineStepKind) -> Bool {
        switch kind {
        case .thinking, .tool, .waiting, .retrying, .other: true
        case .note, .steer, .error, .progress: false
        }
    }

    /// The ids of the chat's running Agent/Task calls: a duckling's id is its tool-use id, which is the step's id.
    static func runningAgentIds(_ s: HostSession) -> Set<String> {
        Set((s.ducklings?.items ?? []).filter { $0.kind == .agent && $0.status == .running }.map(\.id))
    }

    /// A tool step that is a duckling running. A call still streaming its input ("Starting a duckling") has no duckling
    /// yet: that is Claude writing it.
    public static func isDucklingStep(_ step: TimelineStep, agentIds: Set<String>) -> Bool {
        step.kind == .tool && step.status == .running && agentIds.contains(step.id)
    }

    /// - `turn`: the open chat's newest turn from its timeline; nil for a chat whose timeline is not held.
    /// - `session`: the host's row (its `state` is the host's word, `ducklings` the helpers).
    public static func resolve(turn: TimelineTurn?, session s: HostSession) -> ClaudeActivity {
        if let turn, turn.isRunning {
            // A press not yet named by the host, or queued behind a turn: Claude's own turn.
            guard turn.state == .running else { return .claude }
            if turn.streaming != nil { return .claude }
            let live = turn.steps.filter { $0.status == .running && isClaudeWork($0.kind) }
            if live.isEmpty { return .claude }
            let ids = runningAgentIds(s)
            return live.allSatisfy { isDucklingStep($0, agentIds: ids) } ? .ducklingsOnly(turnOpen: true) : .claude
        }
        if s.state == .working {
            // No timeline to read (or it lags the host): the host's own flag, else the host's word that it works.
            if turn == nil, s.hostDucklingsOnly == true { return .ducklingsOnly(turnOpen: true) }
            return .claude
        }
        let helpers = s.backgroundRunning > 0 || (s.ducklings?.running ?? 0) > 0
        return helpers ? .ducklingsOnly(turnOpen: false) : .none
    }

    /// What the open chat resolved to, for the pipeline below.
    public struct Open: Equatable, Sendable {
        public var key: SessionKey
        public var activity: ClaudeActivity
        public init(key: SessionKey, activity: ClaudeActivity) { self.key = key; self.activity = activity }
    }

    /// A Squeak chat the host calls working while only a duckling it waits on works is read as ready with ducklings at
    /// work: no running row, no Stop, a still mark, a normal composer that queues or steers (`turnOpen`). Anything else
    /// is returned as it came.
    public static func apply(to s: HostSession, activity: ClaudeActivity) -> HostSession {
        guard s.source == .squeak, s.state == .working, activity.turnOpen else { return s }
        var out = s
        out.state = .finished
        out.turnOpen = true
        return out
    }

    /// The pipeline's step: the open chat uses what its timeline resolved to, every other chat the host's flag.
    public static func apply(_ sessions: [HostSession], open: Open?) -> [HostSession] {
        func activity(_ s: HostSession) -> ClaudeActivity? {
            guard s.source == .squeak, s.state == .working else { return nil }
            if let open, open.key == s.key { return open.activity }
            return resolve(turn: nil, session: s)
        }
        guard sessions.contains(where: { activity($0)?.turnOpen == true }) else { return sessions }
        return sessions.map { s in activity(s).map { apply(to: s, activity: $0) } ?? s }
    }
}

/// Everything the open chat's screens read once the activity is known: the same functions the views call, so a replay
/// test asserts what the window draws. `make` is what `SessionDetail` composes from its parts.
public struct DucklingSurface: Equatable, Sendable {
    public var activity: ClaudeActivity
    /// The host's row as every list reads it (`ClaudeActivity.apply`).
    public var session: HostSession
    public var dock: ChatDock.Resolved
    public var placeholder: String
    public var mark: ChatMark?

    /// The running row (glyph, clock, "Working…").
    public var showsRunningRow: Bool { dock.showsRow }
    /// The composer's big stop button.
    public var stopInComposer: Bool { dock.canStop }
    /// The quiet Stop on the ducklings bar: only while Claude's turn waits on a foreground duckling.
    public var stopOnBar: Bool { session.turnOpen == true }
    /// A message is queued or steered (Claude is mid-turn), not started as a new turn.
    public var queuesAndSteers: Bool { session.state == .working || session.turnOpen == true }
    /// The sidebar, dashboard and tab mark: a ducklings-at-work mark that is still (`quiet`), never the moving glyph.
    public var markIsStill: Bool { mark?.kind == .working && mark?.quiet == true }

    public static func make(
        timeline: TurnTimeline, host: HostSession, agent: String = "Claude", model: String? = nil, now: Date = Date()
    ) -> DucklingSurface {
        let turn = timeline.current ?? timeline.turns.last
        let activity = ClaudeActivity.resolve(turn: turn, session: host)
        let session = ClaudeActivity.apply(to: host, activity: activity)
        let steps = turn.map { TimelineSteps.activity(of: $0, now: now) } ?? []
        let dock = ChatDock.resolve(
            liveState: session.state, messages: [], awaitingApproval: false, backgroundCount: host.backgroundCount ?? 0,
            backgroundWaiting: false, hostStatus: host.state == .working ? "working" : "idle", hostBackgroundCount: host.backgroundCount,
            optimistic: false, hostOwnsState: true, hasStopRoute: true, activity: steps, model: model, ducklings: host.ducklings,
            turnOpen: session.turnOpen == true, now: now)
        let phase: ComposerPhase = session.state == .working || session.turnOpen == true ? .working : .idle
        return DucklingSurface(
            activity: activity, session: session, dock: dock,
            placeholder: ComposerPrompt.placeholder(agent: agent, workspace: nil, phase: phase, waitingOnDuckling: session.turnOpen == true),
            mark: ChatMark.of(session, unread: false, now: now))
    }
}
