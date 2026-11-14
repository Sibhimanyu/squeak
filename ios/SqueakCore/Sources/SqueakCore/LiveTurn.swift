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
        /// The rowid of the entry's last message on the Mac, as a string: what a page asks to go `before`.
        /// Absent from an older Mac.
        public let id: String?
        /// "user" or "assistant".
        public let role: String
        public let text: String
        public let at: String?
        /// Tool calls the agent made since the entry before this one: the work between two messages, which has
        /// no words of its own. Absent when there was none, and from an older Mac.
        public let workBefore: Int?

        public init(role: String, text: String, at: String? = nil, workBefore: Int? = nil, id: String? = nil) {
            self.role = role; self.text = text; self.at = at; self.workBefore = workBefore; self.id = id
        }

        /// Whether two entries are the same message: by id when both have one, else by role, time and words.
        public func isSame(as other: HistoryEntry) -> Bool {
            if let a = id, let b = other.id { return a == b }
            return role == other.role && at == other.at && text == other.text
        }

        public var date: Date? { at.flatMap(ISO8601DateFormatter.squeakParse) }
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

    /// The `live` document of one page of earlier history: the chat's handle, `-h`, then the cursor or `latest`.
    public static func historyPageDoc(for sessionKey: String, before: String?) -> String {
        handle(for: sessionKey) + "-h" + (before ?? "latest")
    }

    /// The `live` document of the messages after a cursor (history cache): the chat's handle, `-ha`, the cursor.
    public static func historyDeltaDoc(for sessionKey: String, after: String) -> String {
        handle(for: sessionKey) + "-ha" + after
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
    /// The id of the pond whose page is open (`PhoneSnapshot.Pond.id`), so the Mac sends `pondDetail` for it. Absent
    /// when none is open; an older Mac ignores it.
    public var pond: String? = nil

    public init(at: Int64, watching: String? = nil, recent: Int? = nil, caps: [String]? = nil, pond: String? = nil) {
        self.at = at; self.watching = watching; self.recent = recent; self.caps = caps; self.pond = pond
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

    /// The phone pings every 10 s (`pingEvery`) and the Mac answers at most
    /// 10 s apart; 25 s with no answer is a Mac that is not there. `lookingSince` is when the
    /// app came on screen: the answer on record then is from the last visit.
    public static let answerWindow: TimeInterval = 25
    public static let openGrace: TimeInterval = 15
    /// How often the phone pings while on screen. Pings, not snapshots, drive liveness: a quiet Mac writes no view.
    public static let pingEvery: TimeInterval = 10

    public static func read(aliveAt: Date?, lookingSince: Date?, now: Date = Date()) -> MacLiveness {
        guard let aliveAt else { return .unknown }
        if now.timeIntervalSince(aliveAt) < answerWindow { return .answering }
        if let lookingSince, now.timeIntervalSince(lookingSince) < openGrace { return .checking }
        return .silent(since: aliveAt)
    }
}

/// One page of a chat's earlier messages (`live/<handle>-h<before|latest>`), sealed like the live turn.
public struct HistoryPage: Codable, Equatable, Sendable {
    public let v: Int
    public let key: String
    public let before: String?
    /// Oldest first, at most 12.
    public let entries: [LiveTurn.HistoryEntry]
    /// What to send as the next `before`; nil at the start of the chat.
    public let nextBefore: String?
    public let complete: Bool
    public var seq: Int64? = nil

    public init(v: Int = 1, key: String, before: String?, entries: [LiveTurn.HistoryEntry], nextBefore: String?, complete: Bool, seq: Int64? = nil) {
        self.v = v; self.key = key; self.before = before; self.entries = entries
        self.nextBefore = nextBefore; self.complete = complete; self.seq = seq
    }
}

/// What came after the newest message the phone holds (`live/<handle>-ha<cursor>`, the Mac's history-delta.ts),
/// sealed like the live turn. `entries` are oldest first and contiguous with the cursor, unless `reset`: the cursor
/// was out of the Mac's reach, and `entries` are the chat's newest page, to merge like a live push.
public struct HistoryDelta: Codable, Equatable, Sendable {
    public let v: Int
    public let key: String
    public let after: String
    public let entries: [LiveTurn.HistoryEntry]
    /// What to send as the next `after`; nil when this page reaches the newest message.
    public let nextAfter: String?
    public let reset: Bool
    public var seq: Int64? = nil

    public init(v: Int = 1, key: String, after: String, entries: [LiveTurn.HistoryEntry], nextAfter: String?, reset: Bool, seq: Int64? = nil) {
        self.v = v; self.key = key; self.after = after; self.entries = entries
        self.nextAfter = nextAfter; self.reset = reset; self.seq = seq
    }
}

/// What the phone holds of one chat's history: the newest eight the Mac pushes live, and the older pages asked
/// for since. Pure, so CI can test the merging: the live push lands over the tail instead of replacing it, and an
/// older page lands in front without repeating anything.
public struct ChatHistoryState: Codable, Equatable, Sendable {
    /// In memory this many entries are kept per chat (the oldest go first); on disk `ChatHistoryStore.maxEntries`.
    public static let memoryCap = 1000

    /// Oldest first.
    public var entries: [LiveTurn.HistoryEntry]
    /// The cursor for the next older page; nil when not known yet (only the live push is held).
    public var nextBefore: String?
    /// The oldest message of the chat is in `entries`.
    public var complete: Bool

    public init(entries: [LiveTurn.HistoryEntry] = [], nextBefore: String? = nil, complete: Bool = false) {
        self.entries = entries; self.nextBefore = nextBefore; self.complete = complete
    }

    /// What to send as `before` for the next older page: the cursor the Mac gave, else the oldest entry's id,
    /// else nil (the newest page, which the merge dedupes against what is held).
    public var cursor: String? { complete ? nil : nextBefore ?? entries.first?.id }

    /// A hole in the held history: the phone was away while more happened than the Mac's live push carries (the
    /// newest eight), so the push does not reach back to what was held. `above` is the first message of the part
    /// after the hole (new pages go in front of it); `before` is what to send to fetch the page behind it.
    public struct Gap: Codable, Equatable, Sendable {
        public let above: String
        public let before: String

        public init(above: String, before: String) { self.above = above; self.before = before }
    }

    /// The hole in `entries`, if the push did not join what was held. Only one is tracked: a second hole drops
    /// what lay below the first (it is older than anything the reader can reach without the first being filled).
    public var gap: Gap?

    /// The Mac's live push of the newest entries. Everything older that is held stays; when the push does not
    /// reach back to it, `gap` says where the missing messages go.
    public mutating func mergeLatest(_ live: [LiveTurn.HistoryEntry]) {
        guard !live.isEmpty else { return }
        guard !entries.isEmpty else { entries = live; gap = nil; return }
        if let i = entries.firstIndex(where: { $0.isSame(as: live[0]) }) {
            let top = gap.flatMap { g in entries.firstIndex { $0.id == g.above } }
            entries = Array(entries[..<i]) + live
            // The push reached below the hole's far side: joined. Otherwise the hole stays while its edge does.
            if let top, i >= top, let g = gap, entries.contains(where: { $0.id == g.above }) { /* still open */ } else { gap = nil }
        } else if let first = live[0].date {
            // No overlap: keep what is strictly older than the push. An undated entry cannot be placed.
            var older = entries.filter { ($0.date ?? .distantFuture) < first }
            if let g = gap, let top = older.firstIndex(where: { $0.id == g.above }) {
                // An earlier hole is still open: what lies below it cannot be joined to anything, so it goes.
                older = Array(older[top...])
                nextBefore = nil
                complete = false
            }
            entries = older + live
            if !older.isEmpty, let id = live[0].id { gap = Gap(above: id, before: id) } else { gap = nil }
        } else {
            entries = live
            gap = nil
        }
        trim()
    }

    /// A page fetched to fill the hole (`HistoryPage` of `gap.before`): it goes in front of the part after the
    /// hole, minus what is held. True when the hole is closed (the page reached what was held, or the chat's
    /// start, or the Mac had nothing more); false when more is still missing and `gap` points at the next page.
    @discardableResult
    public mutating func fill(_ page: HistoryPage) -> Bool {
        guard let g = gap, let top = entries.firstIndex(where: { $0.id == g.above }) else { gap = nil; return true }
        let below = entries[..<top]
        var joined = page.complete || page.entries.isEmpty
            || page.entries.contains { e in below.contains { $0.isSame(as: e) } }
        let tail = below.last?.date
        if !joined, let tail, let oldest = page.entries.first?.date, oldest <= tail { joined = true }
        var fresh = page.entries.filter { e in !entries.contains { $0.isSame(as: e) } }
        if joined, let tail { fresh = fresh.filter { ($0.date ?? .distantFuture) > tail } }
        entries.insert(contentsOf: fresh, at: top)
        if joined {
            gap = nil
        } else if let before = page.nextBefore ?? fresh.first?.id {
            gap = Gap(above: fresh.first?.id ?? g.above, before: before)
        } else {
            gap = nil
        }
        trim()
        return gap == nil
    }

    /// The cursor to ask the Mac for what came after: the newest held entry's id. Nil when nothing is held or the
    /// newest entry has no id (an older Mac), in which case the live push alone fills the tail.
    public var newestCursor: String? { entries.last?.id }

    /// A delta page (`HistoryDelta`): entries after the cursor join the tail, minus what is already held (the live
    /// push may have brought some). A `reset` page does not join the cursor, so it merges like a live push and
    /// leaves a hole for the usual catch-up. True when more follows (ask again from `newestCursor`).
    @discardableResult
    public mutating func applyDelta(_ delta: HistoryDelta) -> Bool {
        if delta.reset {
            mergeLatest(delta.entries)
            return false
        }
        let fresh = delta.entries.filter { e in !entries.contains { $0.isSame(as: e) } }
        entries.append(contentsOf: fresh)
        trim()
        return delta.nextAfter != nil && !fresh.isEmpty
    }

    /// An older page, from `HistoryPage`: it goes in front, minus what is already held.
    public mutating func prepend(_ page: HistoryPage) {
        let fresh = page.entries.filter { entry in !entries.contains { $0.isSame(as: entry) } }
        entries = fresh + entries
        nextBefore = page.nextBefore
        complete = page.complete || page.nextBefore == nil
        trim()
    }

    private mutating func trim() { trimTo(Self.memoryCap) }

    /// Keeps the newest `limit` entries; the cursor moves to the oldest kept so the dropped ones can be fetched again.
    public mutating func trimTo(_ limit: Int) {
        guard entries.count > limit else { return }
        entries.removeFirst(entries.count - limit)
        if let id = entries.first?.id { nextBefore = id; complete = false }
        // A hole whose far side is the oldest message held has nothing below it left to join.
        if let g = gap, entries.first?.id == g.above || !entries.contains(where: { $0.id == g.above }) { gap = nil }
    }

    /// The live push laid over what is held, without keeping either: what a chat shows.
    public static func overlay(_ held: [LiveTurn.HistoryEntry]?, _ live: [LiveTurn.HistoryEntry]?) -> [LiveTurn.HistoryEntry]? {
        guard let live, !live.isEmpty else { return held }
        guard let held, !held.isEmpty else { return live }
        var state = ChatHistoryState(entries: held)
        state.mergeLatest(live)
        return state.entries
    }
}
