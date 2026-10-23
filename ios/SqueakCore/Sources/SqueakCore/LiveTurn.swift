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
    /// The session's state and current turn as the Mac saw them, and `seq` from the snapshot's
    /// counter: whichever of the two is newer says what the open chat is doing. Older Macs omit them.
    public var state: String? = nil
    public var turnId: String? = nil
    public var seq: Int64? = nil
    /// True when the history is in its own document (`LiveHistory`) rather than here.
    public var split: Bool? = nil
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
        /// Tool calls the agent made since the entry before this one: the work between two messages, which has
        /// no words of its own. Absent when there was none, and from an older Mac.
        public let workBefore: Int?

        public init(role: String, text: String, at: String? = nil, workBefore: Int? = nil) {
            self.role = role; self.text = text; self.at = at; self.workBefore = workBefore
        }
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

/// A live turn's history on its own (`live/<handle>-h`), written only when it changes.
public struct LiveHistory: Codable, Equatable, Sendable {
    public let v: Int
    public let key: String
    public var seq: Int64? = nil
    public let history: [LiveTurn.HistoryEntry]
}

/// What the phone's presence ping says, sealed: when it was last on screen
/// and, in verbose mode, which session it is watching.
public struct Presence: Codable, Equatable, Sendable {
    public let at: Int64
    /// The session open on screen, only when verbose mode is on.
    public let watching: String?
    /// How many recent chats to send, after "Show more"; absent means the Mac's default (10).
    public let recent: Int?
    /// What this phone can read (`ChannelCrypto.capabilities`); an older Mac ignores it.
    public var caps: [String]? = nil

    public init(at: Int64, watching: String? = nil, recent: Int? = nil, caps: [String]? = nil) {
        self.at = at; self.watching = watching; self.recent = recent; self.caps = caps
    }
}

/// The Mac's answer to a presence ping, sealed: its own clock when it last
/// heard this phone. The view is only rewritten when something changes, so
/// this is what tells a quiet Mac from one that is asleep or off.
public struct MacAlive: Codable, Equatable, Sendable {
    public let at: Int64

    public init(at: Int64) { self.at = at }

    public var date: Date { Date(timeIntervalSince1970: Double(at) / 1000) }
}

/// Whether the Mac is answering this phone's presence pings.
public enum MacLiveness: Equatable, Sendable {
    /// No answer has ever been seen: an older Mac. Say nothing either way.
    case unknown
    case answering
    /// Just opened: the first ping's answer is on its way.
    case checking
    /// Asleep, off, or offline since this time.
    case silent(since: Date)

    /// The phone pings every 20 s and the Mac answers within a few; a minute
    /// with no answer is a Mac that is not there. `lookingSince` is when the
    /// app came on screen: the answer on record then is from the last visit.
    public static let answerWindow: TimeInterval = 60
    public static let openGrace: TimeInterval = 30

    public static func read(aliveAt: Date?, lookingSince: Date?, now: Date = Date()) -> MacLiveness {
        guard let aliveAt else { return .unknown }
        if now.timeIntervalSince(aliveAt) < answerWindow { return .answering }
        if let lookingSince, now.timeIntervalSince(lookingSince) < openGrace { return .checking }
        return .silent(since: aliveAt)
    }
}
