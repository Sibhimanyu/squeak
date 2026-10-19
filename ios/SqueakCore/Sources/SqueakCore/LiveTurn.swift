import CryptoKit
import Foundation

/// The verbose view of one session (src/remote/live-turn.ts): its whole
/// current turn, thinking included, written by the Mac only while this phone
/// asks for it and has that session open, and deleted when it stops looking.
public struct LiveTurn: Codable, Equatable, Sendable {
    public struct Step: Codable, Equatable, Sendable {
        public let kind: String
        public let text: String
        public let at: String?

        public init(kind: String, text: String, at: String? = nil) { self.kind = kind; self.text = text; self.at = at }
    }

    public let v: Int
    public let key: String
    public let working: Bool
    /// How many steps the turn has had; `steps` holds the newest of them.
    public let total: Int
    public let steps: [Step]
    /// Conductor's queue for this chat, oldest first. Absent when the Mac cannot read it
    /// (Conductor's relay is not connected); empty when nothing is queued.
    public var queue: [QueuedMessage]? = nil
    /// The chat before this turn, oldest first: what you typed and the agent's answer to each,
    /// the newest eight. Absent when the Mac cannot read the chat.
    public var history: [HistoryEntry]? = nil

    public struct HistoryEntry: Codable, Equatable, Sendable {
        /// "user" or "assistant".
        public let role: String
        public let text: String
        public let at: String?

        public init(role: String, text: String, at: String? = nil) { self.role = role; self.text = text; self.at = at }
    }

    public struct QueuedMessage: Codable, Equatable, Sendable, Identifiable {
        public let id: String
        public let text: String
        public let mode: String?
        public let position: Int?

        public init(id: String, text: String, mode: String? = nil, position: Int? = nil) {
            self.id = id; self.text = text; self.mode = mode; self.position = position
        }
    }

    public init(v: Int = 1, key: String, working: Bool, total: Int, steps: [Step], queue: [QueuedMessage]? = nil,
                history: [HistoryEntry]? = nil) {
        self.v = v; self.key = key; self.working = working; self.total = total; self.steps = steps; self.queue = queue
        self.history = history
    }

    /// The document id for a session: the same as the Mac's `liveHandle`.
    public static func handle(for sessionKey: String) -> String {
        let digest = SHA256.hash(data: Data(sessionKey.utf8))
        let base64url = Data(digest).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return String(base64url.prefix(22))
    }
}

/// What the phone's presence ping says, sealed: when it was last on screen
/// and, in verbose mode, which session it is watching.
public struct Presence: Codable, Equatable, Sendable {
    public let at: Int64
    /// The session open on screen, only when verbose mode is on.
    public let watching: String?
    /// How many recent chats to send, after "Show more"; absent means the Mac's default (10).
    public let recent: Int?

    public init(at: Int64, watching: String? = nil, recent: Int? = nil) {
        self.at = at; self.watching = watching; self.recent = recent
    }
}
