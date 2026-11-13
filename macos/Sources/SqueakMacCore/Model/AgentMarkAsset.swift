import Foundation

/// Which app mark stands for an agent: the same two PNGs the iPhone ships
/// (`agent-claude`, `agent-codex`), drawn in their own colours. Anything else has
/// no mark and gets a neutral terminal tile, never another app's icon.
public enum AgentMarkAsset: String, CaseIterable, Sendable {
    case claude = "agent-claude"
    case codex = "agent-codex"

    /// The file name inside `assets/agents` (checkout) or `Contents/Resources/brand/agents` (app).
    public var fileName: String { "\(rawValue).png" }

    public var title: String {
        switch self {
        case .claude: "Claude"
        case .codex: "Codex"
        }
    }

    /// A daemon `agent` value (`claude`, `codex`), case-insensitive.
    public init?(agent: String?) {
        switch agent?.lowercased() {
        case "claude": self = .claude
        case "codex": self = .codex
        default: return nil
        }
    }

    /// A provider string: `<agent>-<origin>` (`claude-terminal`, `codex-desktop` ...), `claude-cowork`.
    /// `conductor` has no mark: the agent is unknown.
    public init?(provider: String) {
        if provider == "conductor" { return nil }
        guard let head = provider.split(separator: "-").first else { return nil }
        self.init(agent: String(head))
    }
}

public extension HostSession {
    /// The mark for the agent this session runs: its `agent`, else the provider's prefix.
    var agentMark: AgentMarkAsset? {
        AgentMarkAsset(agent: agent) ?? AgentMarkAsset(provider: key.provider)
    }

    /// Conductor holds this chat, so it gets the Conductor chat symbol (the iPhone's `conductorSessionId != nil`).
    var showsConductorBadge: Bool { conductorSessionId != nil || source == .conductor }
}

public extension NewChatAgent {
    var mark: AgentMarkAsset { self == .claude ? .claude : .codex }
}
