import Foundation

/// The Mac's view for the phone (RemoteBridge.phoneView on the Mac).
public struct PhoneSnapshot: Codable, Equatable, Sendable {
    public struct Duck: Codable, Equatable, Sendable {
        public let blockedCount: Int
        public let workingCount: Int
        public init(blockedCount: Int, workingCount: Int) { self.blockedCount = blockedCount; self.workingCount = workingCount }
    }

    public struct Option: Codable, Equatable, Sendable, Identifiable {
        public let letter: String
        public let title: String
        public var id: String { letter }
        public init(letter: String, title: String) { self.letter = letter; self.title = title }
    }

    public struct Choices: Codable, Equatable, Sendable {
        public let question: String?
        public let options: [Option]
        public let recommended: String?
        public init(question: String?, options: [Option], recommended: String?) {
            self.question = question; self.options = options; self.recommended = recommended
        }
    }

    /// One step of a working session's current turn (fleet/activity.ts on the Mac).
    public struct Step: Codable, Equatable, Sendable {
        /// "thinking", "note", "tool" or "background".
        public let kind: String
        public let text: String
        public init(kind: String, text: String) { self.kind = kind; self.text = text }
    }

    /// The newest few steps of the turn so far, and how many it has had.
    public struct Activity: Codable, Equatable, Sendable {
        public let total: Int
        public let steps: [Step]
        public init(total: Int, steps: [Step]) { self.total = total; self.steps = steps }
    }

    public struct Session: Codable, Equatable, Sendable, Identifiable {
        public let key: String
        public let conductorSessionId: String?
        public let label: String
        /// The chat's own title, when the Mac sends it (optional: an older Mac does not).
        public let title: String?
        public let agent: String
        public let state: String
        public let lastActivityAt: String
        public let detail: String?
        public let git: String?
        public let contextPercent: Double?
        public let turnId: String?
        public let message: String?
        public let choices: Choices?
        /// Only while working, and only from a Mac new enough to send it.
        public let activity: Activity?
        public var id: String { key }

        public init(
            key: String, conductorSessionId: String?, label: String, agent: String, state: String,
            lastActivityAt: String, detail: String?, git: String?, contextPercent: Double?,
            turnId: String?, message: String?, choices: Choices?, activity: Activity? = nil,
            title: String? = nil
        ) {
            self.title = title
            self.key = key; self.conductorSessionId = conductorSessionId; self.label = label
            self.agent = agent; self.state = state; self.lastActivityAt = lastActivityAt
            self.detail = detail; self.git = git; self.contextPercent = contextPercent
            self.turnId = turnId; self.message = message; self.choices = choices; self.activity = activity
        }

        /// DESIGN.md §9 vocabulary.
        public var stateWord: String {
            switch state {
            case "awaiting_approval": return "needs approval"
            case "awaiting_input": return "needs an answer"
            case "working": return "working"
            case "finished": return "done"
            case "error": return "error"
            default: return "idle"
            }
        }

        public var needsYou: Bool { state == "awaiting_approval" || state == "awaiting_input" }

        /// A phone can reply only to a Conductor chat that is not holding a
        /// question open inside Conductor — the same rule as on the Mac.
        public var canReply: Bool { conductorSessionId != nil && !needsYou }
    }

    /// One plan window: how much is used (0-100) and when it resets (ISO).
    public struct UsageWindow: Codable, Equatable, Sendable {
        public let usedPercent: Double
        public let resetsAt: String
        public init(usedPercent: Double, resetsAt: String) { self.usedPercent = usedPercent; self.resetsAt = resetsAt }
    }

    /// Claude's plan limits as Claude Code last reported them, with when that was.
    public struct ClaudeUsage: Codable, Equatable, Sendable {
        public let fiveHour: UsageWindow?
        public let sevenDay: UsageWindow?
        public let observedAt: String
        public init(fiveHour: UsageWindow?, sevenDay: UsageWindow?, observedAt: String) {
            self.fiveHour = fiveHour; self.sevenDay = sevenDay; self.observedAt = observedAt
        }
    }

    /// Codex's account quota, live from its own files.
    public struct CodexUsage: Codable, Equatable, Sendable {
        public let fiveHour: UsageWindow?
        public let weekly: UsageWindow?
        public let observedAt: String
        public init(fiveHour: UsageWindow?, weekly: UsageWindow?, observedAt: String) {
            self.fiveHour = fiveHour; self.weekly = weekly; self.observedAt = observedAt
        }
    }

    /// Read-only. Each is null until the Mac has seen a reading; refreshing Claude's is a Mac action.
    public struct Usage: Codable, Equatable, Sendable {
        public let claude: ClaudeUsage?
        public let codex: CodexUsage?
        public init(claude: ClaudeUsage?, codex: CodexUsage?) { self.claude = claude; self.codex = codex }
    }

    public let v: Int
    public let mac: String
    public let generatedAt: String
    public let duck: Duck
    /// Optional: a Mac older than the usage view does not send it.
    public let usage: Usage?
    public let sessions: [Session]

    public init(v: Int, mac: String, generatedAt: String, duck: Duck, sessions: [Session], usage: Usage? = nil) {
        self.v = v; self.mac = mac; self.generatedAt = generatedAt; self.duck = duck; self.sessions = sessions
        self.usage = usage
    }

    /// Attention order, DESIGN.md §8.2.
    public static let groups: [(title: String, states: [String])] = [
        ("Needs you", ["awaiting_approval", "awaiting_input"]),
        ("Done", ["finished"]),
        ("Working", ["working"]),
        ("Error", ["error"]),
        ("Idle", ["idle"]),
    ]
}

/// How a message meets an agent that is mid-turn. Queue waits for the turn to end; steer goes into it.
public enum ReplyMode: String, Codable, Equatable, Sendable {
    case queue, steer
}

/// A reply, exactly as the Mac verifies it (RemoteCommand on the Mac).
public struct ReplyCommand: Codable, Equatable, Sendable {
    public let v: Int
    public let sessionId: String
    public let answersTurn: String?
    public let text: String
    /// Optional, and signed with the rest. Left out for a queued reply: absent means queue.
    public let mode: ReplyMode?
    public let nonce: String
    /// Epoch milliseconds.
    public let expiresAt: Int64
}

/// What the Mac wrote back for a command.
public struct CommandResult: Codable, Equatable, Sendable {
    public let status: String
    public let via: String?
    public let reason: String?
    public let fallbackReason: String?
    /// "sent", "queued" or "steered"; absent from a Mac older than queue/steer.
    public let delivery: String?
    /// Set when a request could not be honoured as asked (steer fell back to queue).
    public let note: String?

    public var sent: Bool { status == "sent" }
}

public struct PairingAnswer: Codable, Equatable, Sendable {
    public let approved: Bool
    public let mac: String?
}
