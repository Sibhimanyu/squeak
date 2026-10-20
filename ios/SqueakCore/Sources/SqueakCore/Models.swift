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

    /// A question the agent is waiting on (its AskUserQuestion), whole: every option, read-only on
    /// the phone for now. Agent text: render as plain text only.
    public struct Question: Codable, Equatable, Sendable {
        public struct Prompt: Codable, Equatable, Sendable {
            public struct Option: Codable, Equatable, Sendable {
                public let label: String
                public let description: String?
                public init(label: String, description: String?) { self.label = label; self.description = description }
            }
            public let question: String
            public let header: String?
            public let multiSelect: Bool
            public let options: [Option]
            public init(question: String, header: String?, multiSelect: Bool, options: [Option]) {
                self.question = question; self.header = header; self.multiSelect = multiSelect; self.options = options
            }
        }
        public let questions: [Prompt]
        /// The pending tool call these questions came from. An answer names it, so the Mac can refuse one
        /// for a question that is no longer the one waiting (ANSWER-CARD). Absent from an older Mac.
        public let toolUseId: String?
        /// For a plan waiting on approval (ExitPlanMode), its text; `questions` is empty then.
        public var plan: String? = nil
        public init(toolUseId: String? = nil, questions: [Prompt], plan: String? = nil) {
            self.questions = questions; self.toolUseId = toolUseId; self.plan = plan
        }
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
        /// Only while it waits on an answer, and only from a Mac new enough to send it.
        public let question: Question?
        public var id: String { key }

        public init(
            key: String, conductorSessionId: String?, label: String, agent: String, state: String,
            lastActivityAt: String, detail: String?, git: String?, contextPercent: Double?,
            turnId: String?, message: String?, choices: Choices?, activity: Activity? = nil,
            title: String? = nil, question: Question? = nil
        ) {
            self.title = title; self.question = question
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

    /// A workspace a new chat can start in (the Mac lists at most 20, newest first).
    public struct Workspace: Codable, Equatable, Sendable, Identifiable {
        public let id: String
        /// "repo · branch"
        public let label: String
        /// "claude" or "codex": what that workspace last used.
        public let defaultAgent: String
        public init(id: String, label: String, defaultAgent: String) {
            self.id = id; self.label = label; self.defaultAgent = defaultAgent
        }
        public var agent: NewChatAgent { NewChatAgent(rawValue: defaultAgent) ?? .claude }
    }

    public let v: Int
    public let mac: String
    public let generatedAt: String
    public let duck: Duck
    /// Optional: a Mac older than the usage view does not send it.
    public let usage: Usage?
    /// Optional: a Mac older than new chats does not send it, and the phone then hides "New chat".
    public let workspaces: [Workspace]?
    public let sessions: [Session]
    /// Conductor chats that are no longer active, newest first, to pick up
    /// again. Optional: a Mac older than this does not send it.
    public let recent: [Session]?
    /// Whether the Mac has more recent chats than it sent ("Show more"). Optional: older Macs omit it.
    public let recentMore: Bool?
    /// Whether the Mac's awake session runs. Optional: a Mac without sessions omits it, and the phone hides them.
    public let keepAwake: Bool?
    /// When a timed awake session ends (ISO); absent for one that runs until ended, and from older Macs.
    public let awakeUntil: String?
    /// A lid-closed session's state: "on", "starting" or "failed"; absent without one.
    public let awakeLid: String?
    /// Why lid-closed did not turn on.
    public let awakeLidProblem: String?
    /// Whether this Mac can start a lid-closed session (its sudoers rule is installed).
    public let awakeLidReady: Bool?
    /// A safety rule acting on the session now ("Low Power Mode on · Battery at 38%").
    public let awakeSafety: String?
    /// The Mac's battery, power draw and lid, as last read. Optional: older Macs omit it.
    public let macPower: MacPower?
    /// Hotspot failover (src/fleet/hotspot.ts). Optional: older Macs omit it, and the phone hides it.
    public var hotspot: Hotspot? = nil

    public struct Hotspot: Codable, Equatable, Sendable {
        public struct Event: Codable, Equatable, Sendable {
            public let at: String
            /// "hotspot" or "wifi".
            public let to: String
            public let ok: Bool
            public let note: String
            public let automatic: Bool
        }
        public let configured: Bool
        public let ssid: String?
        public let enabled: Bool
        public let onHotspot: Bool
        public let last: Event?
        public init(configured: Bool, ssid: String?, enabled: Bool, onHotspot: Bool, last: Event? = nil) {
            self.configured = configured; self.ssid = ssid; self.enabled = enabled; self.onHotspot = onHotspot; self.last = last
        }
    }

    public struct MacPower: Codable, Equatable, Sendable {
        public let percent: Int?
        public let onBattery: Bool?
        /// Whole watts drawn from the battery; nil when plugged in or unread.
        public let watts: Int?
        public let lidClosed: Bool?
        public init(percent: Int?, onBattery: Bool?, watts: Int?, lidClosed: Bool?) {
            self.percent = percent; self.onBattery = onBattery; self.watts = watts; self.lidClosed = lidClosed
        }
    }

    public init(
        v: Int, mac: String, generatedAt: String, duck: Duck, sessions: [Session], usage: Usage? = nil,
        workspaces: [Workspace]? = nil, recent: [Session]? = nil, recentMore: Bool? = nil, keepAwake: Bool? = nil,
        awakeUntil: String? = nil, awakeLid: String? = nil, awakeLidProblem: String? = nil, awakeLidReady: Bool? = nil,
        awakeSafety: String? = nil, macPower: MacPower? = nil
    ) {
        self.recentMore = recentMore
        self.keepAwake = keepAwake
        self.awakeUntil = awakeUntil
        self.awakeLid = awakeLid; self.awakeLidProblem = awakeLidProblem; self.awakeLidReady = awakeLidReady
        self.awakeSafety = awakeSafety
        self.macPower = macPower
        self.v = v; self.mac = mac; self.generatedAt = generatedAt; self.duck = duck; self.sessions = sessions
        self.usage = usage; self.workspaces = workspaces; self.recent = recent
    }

    /// A session by key, active or recent.
    public func session(_ key: String) -> Session? {
        sessions.first { $0.key == key } ?? recent?.first { $0.key == key }
    }

    /// Active sessions, then recent ones not already among them.
    public var allSessions: [Session] {
        let active = Set(sessions.map(\.key))
        return sessions + (recent ?? []).filter { !active.contains($0.key) }
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
    /// Chosen by the phone and used by Conductor as the queued message's id, so a queued
    /// reply's card can be matched to the Mac's queue (LiveTurn.queue). Absent from older phones.
    public var messageId: String? = nil
}

/// Hotspot failover: set it up, switch the Mac to the hotspot now, or back to its Wi-Fi.
/// The password goes only to the Mac's Keychain.
public struct HotspotCommand: Codable, Equatable, Sendable {
    public enum Action: String, Codable, Sendable { case configure, join, leave }
    public let v: Int
    public let kind: String
    public let action: Action
    public let ssid: String?
    public let password: String?
    public let enabled: Bool?
    public let nonce: String
    /// Epoch milliseconds.
    public let expiresAt: Int64
}

/// Ask for an image a chat's agent showed (`![alt](source)`); `source` exactly as the chat wrote it.
public struct ImageCommand: Codable, Equatable, Sendable {
    public let v: Int
    public let kind: String
    public let sessionId: String
    public let source: String
    public let nonce: String
    /// Epoch milliseconds.
    public let expiresAt: Int64
}

/// An image as the Mac sends it: shrunk to a JPEG, base64.
public struct PhoneImage: Codable, Equatable, Sendable {
    public let mime: String
    public let data: String
    public init(mime: String, data: String) { self.mime = mime; self.data = data }
}

/// Ask what a chat changed: its file list, and one file's patch when `file` is its index.
public struct DiffCommand: Codable, Equatable, Sendable {
    public let v: Int
    public let kind: String
    public let sessionId: String
    public let file: Int?
    public let nonce: String
    /// Epoch milliseconds.
    public let expiresAt: Int64
}

/// A chat's changes against its base branch, as the Mac read them (fleet/diff-view.ts).
public struct WorkspaceDiff: Codable, Equatable, Sendable {
    public struct File: Codable, Equatable, Sendable, Identifiable {
        public let path: String
        public let insertions: Int
        public let deletions: Int
        public let binary: Bool
        public let untracked: Bool
        public var id: String { path }

        public init(path: String, insertions: Int, deletions: Int, binary: Bool, untracked: Bool) {
            self.path = path; self.insertions = insertions; self.deletions = deletions; self.binary = binary; self.untracked = untracked
        }
    }
    public let baseRef: String?
    public let files: [File]
    public let insertions: Int
    public let deletions: Int
    public let truncated: Bool

    public init(baseRef: String?, files: [File], insertions: Int, deletions: Int, truncated: Bool) {
        self.baseRef = baseRef; self.files = files; self.insertions = insertions; self.deletions = deletions; self.truncated = truncated
    }
}

public struct FilePatch: Codable, Equatable, Sendable {
    public let index: Int
    public let path: String
    public let text: String

    public init(index: Int, path: String, text: String) { self.index = index; self.path = path; self.text = text }
}

/// Stop a working chat, as Conductor's own Stop button does. It names the turn the phone saw,
/// so a Stop sent while one turn ran cannot stop the next.
public struct StopCommand: Codable, Equatable, Sendable {
    public let v: Int
    public let kind: String
    public let sessionId: String
    public let answersTurn: String?
    public let nonce: String
    /// Epoch milliseconds.
    public let expiresAt: Int64
}

/// Steer a queued message into the turn now, or take it out of the queue. The
/// queued message's id is the anchor, so there is no turn to match.
public struct QueueCommand: Codable, Equatable, Sendable {
    public enum Action: String, Codable, Equatable, Sendable { case promote, cancel }
    public let v: Int
    public let kind: String
    public let sessionId: String
    public let messageId: String
    public let action: Action
    public let nonce: String
    /// Epoch milliseconds.
    public let expiresAt: Int64
}

/// Which agent a new chat starts with.
public enum NewChatAgent: String, Codable, Equatable, Sendable, CaseIterable {
    case claude, codex
}

/// A request to start a new chat in an existing workspace, exactly as the Mac
/// verifies it (StartCommand on the Mac). It has no session and no turn.
public struct StartCommand: Codable, Equatable, Sendable {
    public let v: Int
    public let kind: String
    public let workspaceId: String
    public let agent: NewChatAgent
    public let text: String
    public let nonce: String
    /// Epoch milliseconds.
    public let expiresAt: Int64
}

/// A signed request for a fresh Claude usage reading (the Mac's Refresh, from
/// the phone). Only the envelope: the Mac runs it at most once a minute.
public struct UsageCommand: Codable, Equatable, Sendable {
    public let v: Int
    public let kind: String
    public let nonce: String
    /// Epoch milliseconds.
    public let expiresAt: Int64
}

/// A signed flip of the Mac's "Keep Mac awake" switch. Reaches no agent.
public struct AwakeCommand: Codable, Equatable, Sendable {
    public let v: Int
    public let kind: String
    /// False ends the session. True starts one for `minutes` (absent: until ended), or adds `extend` minutes.
    public let on: Bool
    public let minutes: Int?
    public let extend: Int?
    /// Stay awake with the lid closed too; needs `minutes`.
    public let lid: Bool?
    public let nonce: String
    /// Epoch milliseconds.
    public let expiresAt: Int64
}

/// An answer to the question an agent is waiting on (docs/answering-questions.md). Signed like a reply;
/// the Mac checks `toolUseId` is still the pending call before delivering it.
public struct AnswerCommand: Codable, Equatable, Sendable {
    public struct Answer: Codable, Equatable, Sendable {
        /// The question's position in the call.
        public let question: Int
        public let picked: [String]
        /// "Something else": the person's own words.
        public let other: String?
        public init(question: Int, picked: [String], other: String? = nil) {
            self.question = question; self.picked = picked; self.other = other
        }
    }
    /// Approve a plan, or send it back with what to change.
    public struct PlanAnswer: Codable, Equatable, Sendable {
        public let approve: Bool
        public let note: String?
        public init(approve: Bool, note: String? = nil) { self.approve = approve; self.note = note }
    }
    public let v: Int
    public let kind: String
    public let sessionId: String
    public let toolUseId: String
    /// A question's answers, or nil for a plan (the Mac takes exactly one of the two).
    public let answers: [Answer]?
    public var plan: PlanAnswer? = nil
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
    /// For a started chat: Conductor's id for it, which the snapshot carries as `conductorSessionId`.
    public let sessionId: String?
    /// For a usage refresh: whether a new reading was taken, or the last minute's was reused.
    public let refreshed: Bool?
    public let throttled: Bool?
    /// For a diff request: the chat's changes, and the patch of the file asked for.
    public var diff: WorkspaceDiff? = nil
    public var patch: FilePatch? = nil
    /// For an image request: the image.
    public var image: PhoneImage? = nil

    public var sent: Bool { status == "sent" }
    /// For an answer: the Mac delivered it (`via` says how: "conductor", "stopped-and-sent").
    public var answered: Bool { status == "answered" }
}

public struct PairingAnswer: Codable, Equatable, Sendable {
    public let approved: Bool
    public let mac: String?
}
