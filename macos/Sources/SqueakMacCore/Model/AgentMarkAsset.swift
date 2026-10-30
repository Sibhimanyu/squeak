import Foundation

/// Which app mark stands for an agent or host: the same three PNGs the iPhone ships
/// (`agent-claude`, `agent-codex`, `agent-conductor`), drawn in their own colours. Anything else has
/// no mark and gets a neutral terminal tile, never another app's icon.
public enum AgentMarkAsset: String, CaseIterable, Sendable {
    case claude = "agent-claude"
    case codex = "agent-codex"
    case conductor = "agent-conductor"

    /// The file name inside `assets/agents` (checkout) or `Contents/Resources/brand/agents` (app).
    public var fileName: String { "\(rawValue).png" }

    public var title: String {
        switch self {
        case .claude: "Claude"
        case .codex: "Codex"
        case .conductor: "Conductor"
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

    /// A provider string: `conductor`, `<agent>-<origin>` (`claude-terminal`, `codex-desktop` ...),
    /// `claude-cowork`. For `conductor` the agent is unknown, so the host's own mark.
    public init?(provider: String) {
        if provider == "conductor" { self = .conductor; return }
        guard let head = provider.split(separator: "-").first else { return nil }
        self.init(agent: String(head))
    }
}

public extension HostSession {
    /// The mark for the agent this session runs: its `agent`, else the provider's prefix.
    var agentMark: AgentMarkAsset? {
        AgentMarkAsset(agent: agent) ?? AgentMarkAsset(provider: key.provider).flatMap { $0 == .conductor ? nil : $0 }
    }

    /// Conductor holds this chat, so it gets the host's badge (the iPhone's `conductorSessionId != nil`).
    var showsConductorBadge: Bool { conductorSessionId != nil || source == .conductor }
}

public extension NewChatAgent {
    var mark: AgentMarkAsset { self == .claude ? .claude : .codex }
}
