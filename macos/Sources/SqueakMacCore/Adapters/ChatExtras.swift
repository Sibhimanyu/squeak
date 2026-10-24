import Foundation

/// What the conversation window shows about a Conductor chat beyond its messages, all from the daemon: what it
/// runs (and the ids its model picker needs), whether it seems stuck, its workspace, and its subagents and
/// background shells. The daemon decides every one of these; the window only draws them.
public struct ChatExtras: Sendable, Equatable {
    public var agent: String?
    public var model: String?
    public var effort: String?
    public var fast: Bool
    public var modelId: String?
    public var effortId: String?
    public var stalled: DaemonStall?
    public var workspaceId: String?
    public var background: [DaemonBackgroundTask]

    public init(agent: String? = nil, model: String? = nil, effort: String? = nil, fast: Bool = false,
                modelId: String? = nil, effortId: String? = nil, stalled: DaemonStall? = nil,
                workspaceId: String? = nil, background: [DaemonBackgroundTask] = []) {
        self.agent = agent; self.model = model; self.effort = effort; self.fast = fast
        self.modelId = modelId; self.effortId = effortId; self.stalled = stalled
        self.workspaceId = workspaceId; self.background = background
    }

    public init(_ d: DaemonSession, background: [DaemonBackgroundTask] = []) {
        self.init(agent: d.agent, model: d.model, effort: d.effort, fast: d.fast == true, modelId: d.modelId,
                  effortId: d.effortId, stalled: d.state == "working" ? d.stalled : nil,
                  workspaceId: d.conductorWorkspaceId, background: d.state == "working" ? background : [])
    }

    /// "Opus 5.5 · 1M · Extra high · Fast"; nil when the daemon named nothing.
    public var setupLine: String? {
        let parts = [model, effort, fast ? "Fast" : nil].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// The models this chat can switch to: the daemon's list for the chat's own agent, never another provider's.
    public func choices(from models: [DaemonChatModel]) -> [DaemonChatModel] {
        guard modelId != nil, let agent else { return [] }
        return models.filter { $0.agent == agent }
    }

    /// "2 subagents, 1 shell · 2 running".
    public var backgroundSummary: String? {
        guard !background.isEmpty else { return nil }
        let agents = background.filter { $0.kind == "agent" }.count
        let shells = background.count - agents
        let running = background.filter { $0.status == "running" }.count
        let what = [agents > 0 ? "\(agents) \(agents == 1 ? "subagent" : "subagents")" : nil,
                    shells > 0 ? "\(shells) \(shells == 1 ? "shell" : "shells")" : nil].compactMap { $0 }.joined(separator: ", ")
        if running == 0 { return "\(what) · all ended" }
        return running == background.count ? "\(what) · running" : "\(what) · \(running) running"
    }
}

extension DaemonClient {
    /// The extras for one Conductor chat: `/state`, plus its activity's background work while it works.
    public func chatExtras(conductorSessionId: String) async -> ChatExtras? {
        guard let state = try? await state(),
              let d = state.sessions.first(where: { $0.conductorSessionId == conductorSessionId }) else { return nil }
        var background: [DaemonBackgroundTask] = []
        if d.state == "working", d.agent == "claude" {
            background = (try? await activity(sessionKey: d.key))?.background ?? []
        }
        return ChatExtras(d, background: background)
    }
}
