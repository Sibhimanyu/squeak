import Foundation

/// Squeak's own (native) chats from the phone: the open request the agent waits on, and starting a chat.
/// The Mac verifies every `native` command like any other (paired device, signature, expiry, nonce) and then
/// matches a `respond` against the session host's *current* open request, so a stale tap never answers a newer
/// one (NativeCommand on the Mac, docs/remote-channel.md "Squeak's own chats from the phone").

/// The open approval, plan or question of a native chat, in the fields the phone draws. Only for a phone whose
/// presence caps name "native".
public struct NativeRequest: Codable, Equatable, Sendable, Identifiable {
    public struct Option: Codable, Equatable, Sendable {
        public let label: String
        public let description: String?
        public init(label: String, description: String? = nil) { self.label = label; self.description = description }
    }
    public struct Question: Codable, Equatable, Sendable {
        public let question: String
        public let header: String?
        public let multiSelect: Bool?
        public let options: [Option]
        public init(question: String, header: String? = nil, multiSelect: Bool? = nil, options: [Option]) {
            self.question = question; self.header = header; self.multiSelect = multiSelect; self.options = options
        }
    }
    public let id: String
    /// "tool", "plan", "question", "command" or "file_change".
    public let kind: String
    public let summary: String
    public var tool: String? = nil
    public var command: String? = nil
    public var path: String? = nil
    public var plan: String? = nil
    public var questions: [Question]? = nil
    /// "Allow for this chat" can be offered: tool, command and file requests only.
    public let chatRule: Bool

    public init(id: String, kind: String, summary: String, tool: String? = nil, command: String? = nil,
                path: String? = nil, plan: String? = nil, questions: [Question]? = nil, chatRule: Bool = false) {
        self.id = id; self.kind = kind; self.summary = summary; self.tool = tool; self.command = command
        self.path = path; self.plan = plan; self.questions = questions; self.chatRule = chatRule
    }
}

/// A project the Mac lists for a new Squeak chat, with the ready workspaces it already has.
public struct NativeProject: Codable, Equatable, Sendable, Identifiable {
    public struct Workspace: Codable, Equatable, Sendable, Identifiable {
        public let id: String
        public let name: String
        /// What the stream is called on screen; nil from a Mac that sends no titles.
        public let title: String?
        public let branch: String
        /// The title, else the folder name.
        public var displayTitle: String {
            let t = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return t.isEmpty ? name : t
        }
        public init(id: String, name: String, branch: String, title: String? = nil) {
            self.id = id; self.name = name; self.branch = branch; self.title = title
        }
    }
    public let id: String
    public let name: String
    public let workspaces: [Workspace]
    public init(id: String, name: String, workspaces: [Workspace]) { self.id = id; self.name = name; self.workspaces = workspaces }
}

/// Where a new Squeak chat runs.
public enum NativeWhere: String, Codable, Equatable, Sendable, CaseIterable {
    case newWorkspace, workspace, folder
}

/// A signed `native` command, exactly as the Mac verifies it. One shape, two actions; absent fields are absent
/// from the signed JSON.
public struct NativeCommand: Codable, Equatable, Sendable {
    public let v: Int
    public let kind: String
    /// "respond" or "start".
    public let action: String
    // respond
    public var sessionKey: String? = nil
    public var requestId: String? = nil
    /// "allow" or "deny".
    public var decision: String? = nil
    public var message: String? = nil
    /// "session": also keep an allow rule for this chat.
    public var scope: String? = nil
    public var answers: [Pick]? = nil
    // start
    public var projectId: String? = nil
    public var `where`: NativeWhere? = nil
    public var workspaceId: String? = nil
    public var agent: NewChatAgent? = nil
    public var model: String? = nil
    public var effort: String? = nil
    public var permissionMode: String? = nil
    public var text: String? = nil
    public let nonce: String
    /// Epoch milliseconds.
    public let expiresAt: Int64

    /// A question's pick: the question's position and the option's label (a multi-select joins labels with ", ").
    public struct Pick: Codable, Equatable, Sendable {
        public let question: Int
        public let picked: String
        public init(question: Int, picked: String) { self.question = question; self.picked = picked }
    }
}

/// What a person's tap on a native request says, before it is signed.
public enum NativeDecision: Equatable, Sendable {
    case allowOnce
    case allowForChat
    case deny(note: String?)
    case answer([NativeCommand.Pick])
}

public struct NativeStart: Equatable, Sendable {
    public var projectId: String
    public var `where`: NativeWhere
    public var workspaceId: String?
    public var agent: NewChatAgent
    public var model: String
    public var effort: String?
    public var permissionMode: String
    public var text: String
    public init(projectId: String, where: NativeWhere, workspaceId: String? = nil, agent: NewChatAgent, model: String,
                effort: String? = nil, permissionMode: String, text: String) {
        self.projectId = projectId; self.where = `where`; self.workspaceId = workspaceId; self.agent = agent
        self.model = model; self.effort = effort; self.permissionMode = permissionMode; self.text = text
    }
}

extension Channel {
    /// The signed document answering a native chat's open request.
    public func nativeRespondDocument(
        sessionKey: String, requestId: String, decision: NativeDecision,
        signer: CommandSigner, now: Date = Date()
    ) throws -> (id: String, document: ChannelDocument) {
        var command = NativeCommand(
            v: 1, kind: "native", action: "respond", nonce: Self.freshNonce(),
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000))
        command.sessionKey = sessionKey
        command.requestId = requestId
        switch decision {
        case .allowOnce: command.decision = "allow"
        case .allowForChat: command.decision = "allow"; command.scope = "session"
        case let .deny(note):
            command.decision = "deny"
            if let note = note?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty { command.message = note }
        case let .answer(picks): command.decision = "allow"; command.answers = picks
        }
        return try nativeSigned(command, signer: signer)
    }

    /// The signed document starting a native chat.
    public func nativeStartDocument(_ start: NativeStart, signer: CommandSigner, now: Date = Date()) throws -> (id: String, document: ChannelDocument) {
        var command = NativeCommand(
            v: 1, kind: "native", action: "start", nonce: Self.freshNonce(),
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000))
        command.projectId = start.projectId
        command.where = start.where
        command.workspaceId = start.where == .workspace ? start.workspaceId : nil
        command.agent = start.agent
        command.model = start.model
        command.effort = start.effort
        command.permissionMode = start.permissionMode
        command.text = start.text
        return try nativeSigned(command, signer: signer)
    }

    private func nativeSigned(_ command: NativeCommand, signer: CommandSigner) throws -> (id: String, document: ChannelDocument) {
        let box = try ChannelCrypto.seal(command, key: pairing.k)
        let id = UUID().uuidString.lowercased()
        return (id, ChannelDocument(box: box, sig: try signer.sign(box), device: deviceId))
    }

    private static func freshNonce() -> String {
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        return nonce.map { String(format: "%02x", $0) }.joined()
    }
}

/// Words for the card and the sheet, decided in one place so they are tested.
public enum NativeWords {
    public static let permissionModes: [(id: String, label: String, note: String)] = [
        ("default", "Ask", "Asks before it runs a command or edits a file."),
        ("acceptEdits", "Accept edits", "Edits files without asking; still asks for commands."),
        ("plan", "Plan", "Plans first and waits for your go-ahead."),
        ("bypassPermissions", "Skip approvals", "Runs every command and edit without asking."),
    ]

    public static func modeLabel(_ id: String) -> String { permissionModes.first { $0.id == id }?.label ?? id }

    /// The card's heading: what is being asked, in a few words.
    public static func heading(_ request: NativeRequest, agentName: String) -> String {
        switch request.kind {
        case "plan": return "\(agentName)'s plan"
        case "question": return "\(agentName) has a question"
        case "command": return "\(agentName) wants to run a command"
        case "file_change": return "\(agentName) wants to change files"
        default: return request.tool.map { "\(agentName) wants to use \($0)" } ?? "\(agentName) needs your approval"
        }
    }

    /// The monospaced line under the heading: the command or path, else the Mac's own summary.
    public static func target(_ request: NativeRequest) -> String? {
        switch request.kind {
        case "plan", "question": return nil
        default: return request.command ?? request.path ?? request.summary
        }
    }
}

extension NativeWords {
    /// The line under the card once the Mac has delivered the answer.
    public static func confirmation(_ decision: NativeDecision, kind: String) -> String {
        switch decision {
        case .allowOnce: return kind == "plan" ? "Approved" : "Allowed"
        case .allowForChat: return "Allowed for this chat"
        case let .deny(note): return kind == "plan" ? "Kept planning" : (note == nil ? "Denied" : "Denied, with your note")
        case .answer: return "Answered"
        }
    }
}
